terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ── Enable APIs ───────────────────────────────────────────────────────────────

resource "google_project_service" "run" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "firestore" {
  service            = "firestore.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "secretmanager" {
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "scheduler" {
  service            = "cloudscheduler.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "iam" {
  service            = "iam.googleapis.com"
  disable_on_destroy = false
}

# ── Service account ───────────────────────────────────────────────────────────

resource "google_service_account" "sync_sa" {
  account_id   = "${var.service_name}-sa"
  display_name = "PB–HubSpot Sync Service Account"
}

# ── Firestore ─────────────────────────────────────────────────────────────────

resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.firestore]
}

resource "google_project_iam_member" "firestore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.sync_sa.email}"
}

# ── Secret Manager ────────────────────────────────────────────────────────────
# Static infra secrets (session signing key, OAuth client). Populate values with:
#   gcloud secrets versions add <name> --data-file=-
#
# Application-level tokens (HubSpot, Productboard) are NOT pre-created here —
# the Connect-tab UI calls writeSecret() at runtime to create
# `hubspot-token` / `productboard-token` and add new versions on each save.
# That dynamic flow needs secretmanager.secrets.create + versions.add at the
# project level on the runtime SA, granted out-of-band (e.g. via
# roles/secretmanager.secretCreator). The project-level secretAccessor binding
# below covers reads for both static and dynamically-created secrets.

resource "google_secret_manager_secret" "session_secret" {
  secret_id = "SESSION_SECRET"
  replication {
    auto {}
  }

  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret" "google_client_id" {
  secret_id = "GOOGLE_CLIENT_ID"
  replication {
    auto {}
  }

  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret" "google_client_secret" {
  secret_id = "GOOGLE_CLIENT_SECRET"
  replication {
    auto {}
  }

  depends_on = [google_project_service.secretmanager]
}

# Project-level read access — covers the static secrets above plus the
# Connect-tab tokens (hubspot-token, productboard-token) that Terraform
# does not declare, and any future runtime-created secret.
resource "google_project_iam_member" "secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.sync_sa.email}"
}

# ── Cloud Run ─────────────────────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "sync" {
  name     = var.service_name
  location = var.region

  template {
    service_account = google_service_account.sync_sa.email

    containers {
      image = var.image

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "GCP_REGION"
        value = var.region
      }
      env {
        name  = "APP_URL"
        value = var.app_url
      }
      env {
        name  = "GOOGLE_ALLOWED_DOMAIN"
        value = var.google_allowed_domain
      }
      env {
        name  = "GOOGLE_ALLOWED_EMAILS"
        value = var.google_allowed_emails
      }
      env {
        name  = "SYNC_CONCURRENCY"
        value = tostring(var.sync_concurrency)
      }
      env {
        name  = "GCS_JOB_NAME"
        value = "projects/${var.project_id}/locations/${var.region}/jobs/${var.service_name}-scheduler"
      }
      env {
        name  = "SCHEDULER_SA_EMAIL"
        value = google_service_account.scheduler_sa.email
      }
      env {
        name  = "SCHEDULER_OIDC_AUDIENCE"
        value = "https://sync-${var.project_id}.a.run.app"
      }

      # Secrets injected as env vars at runtime.
      # HUBSPOT_API_KEY / PB_API_KEY are intentionally NOT injected anymore —
      # those tokens are stored in Secret Manager by the Connect-tab UI and
      # resolved at request time via getHubSpotToken() / getPBToken(). Wiring
      # them as env vars here would let stale or empty values shadow the
      # Firestore-stored connection (env wins in those token getters).
      env {
        name = "SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.session_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GOOGLE_CLIENT_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.google_client_id.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GOOGLE_CLIENT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.google_client_secret.secret_id
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      startup_probe {
        http_get { path = "/health" }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 5
      }
    }

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }
  }

  depends_on = [
    google_project_service.run,
    google_firestore_database.default,
  ]
}

# Allow unauthenticated access — Google OAuth handles app-level auth
resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.sync.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── Cloud Scheduler ───────────────────────────────────────────────────────────

# Dedicated SA for the Scheduler → Cloud Run OIDC call
resource "google_service_account" "scheduler_sa" {
  account_id   = "${var.service_name}-sched-sa"
  display_name = "PB–HubSpot Sync Scheduler Invoker"
}

resource "google_cloud_run_v2_service_iam_member" "scheduler_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.sync.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_sa.email}"
}

resource "google_cloud_scheduler_job" "sync" {
  name             = "${var.service_name}-scheduler"
  description      = "Triggers the pb-hubspot sync endpoint on schedule"
  schedule         = var.scheduler_schedule
  time_zone        = var.scheduler_timezone
  attempt_deadline = "540s"

  http_target {
    http_method = "POST"
    uri         = "${"https://sync-${var.project_id}.a.run.app"}/api/sync/run"
    body        = base64encode(jsonencode({ trigger = "scheduler" }))
    headers = {
      "Content-Type" = "application/json"
    }

    oidc_token {
      service_account_email = google_service_account.scheduler_sa.email
      audience              = "https://sync-${var.project_id}.a.run.app"
    }
  }

  depends_on = [
    google_project_service.scheduler,
    google_cloud_run_v2_service.sync,
  ]
}

# SA needs Cloud Scheduler admin so the sync service can update the job schedule via API
resource "google_project_iam_member" "sync_scheduler_admin" {
  project = var.project_id
  role    = "roles/cloudscheduler.admin"
  member  = "serviceAccount:${google_service_account.sync_sa.email}"
}

# ── Outputs ───────────────────────────────────────────────────────────────────

output "service_url" {
  description = "Cloud Run service URL"
  value       = "https://sync-${var.project_id}.a.run.app"
}

output "scheduler_job_name" {
  description = "Full Cloud Scheduler job resource name (set as GCS_JOB_NAME env var)"
  value       = "projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_scheduler_job.sync.name}"
}

output "service_account_email" {
  description = "Service account used by the Cloud Run service"
  value       = google_service_account.sync_sa.email
}
