variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run and Scheduler"
  type        = string
  default     = "europe-west1"
}

variable "service_name" {
  description = "Cloud Run service name"
  type        = string
  default     = "pb-hubspot-sync"
}

variable "image" {
  description = <<-EOT
    Bootstrap container image used on the very first `terraform apply`.
    The default is Google's public hello-world placeholder so a fresh
    project applies cleanly without anyone having to push an image first.
    Cloud Build CD owns the image attribute from the first `git push`
    onward (see `cloudbuild.yaml` + the `ignore_changes` lifecycle on
    `google_cloud_run_v2_service.sync` in main.tf).
  EOT
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "app_url" {
  description = "Public HTTPS URL of this Cloud Run service (for OAuth callback)"
  type        = string
}

variable "google_allowed_domain" {
  description = "Google Workspace domain allowed to sign in (e.g. acme.com)"
  type        = string
}

variable "google_allowed_emails" {
  description = "Optional comma-separated list of allowed emails (overrides domain restriction)"
  type        = string
  default     = ""
}

variable "sync_concurrency" {
  description = "Number of companies to process in parallel per sync run"
  type        = number
  default     = 5
}

variable "scheduler_schedule" {
  description = "Initial Cloud Scheduler cron expression (can be overridden via the UI)"
  type        = string
  default     = "0 2 * * *"
}

variable "scheduler_timezone" {
  description = "Timezone for the Cloud Scheduler job"
  type        = string
  default     = "UTC"
}

variable "history_retention_days" {
  description = "Number of days to retain sync history in Firestore"
  type        = number
  default     = 90
}
