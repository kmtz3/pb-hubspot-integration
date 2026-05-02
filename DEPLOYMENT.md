# Deployment Guide — pb-hubspot-integration on GCP

A step-by-step guide to deploy the Productboard ↔ HubSpot integration service to Google Cloud Platform. Anyone with this repo, a GCP project, a Productboard token, and a HubSpot service token can follow this guide end to end.

The result: a Cloud Run service with a browser-based admin UI, Firestore as the config store, Cloud Scheduler driving recurring syncs, and Secret Manager holding all credentials.

---

## 1. Prerequisites

Install these on your local machine (one-time setup):

| Tool | Why | Install |
|---|---|---|
| **Google Cloud SDK** (`gcloud`) | Authenticate, push images, manage secrets | https://cloud.google.com/sdk/docs/install |
| **Terraform** ≥ 1.6 | Provision Cloud Run, Firestore, Scheduler, IAM | https://developer.hashicorp.com/terraform/install |
| **Docker** | Build the container image | https://docs.docker.com/get-docker/ |
| **Node.js** ≥ 22 | Only needed if you want to run/test locally first | https://nodejs.org/ |
| **Git** | Clone the repo | – |

You will also need:

- A **GCP project** with billing enabled. Create one at https://console.cloud.google.com/projectcreate. Note the project ID — you'll use it everywhere as `PROJECT_ID`.
- A **Google Workspace domain** for OAuth sign-in restriction (e.g. `acme.com`). Personal `@gmail.com` accounts work too, but the allow-list will need to use specific emails instead of a domain.
- **Owner** or **Editor** role on the project (you need to enable APIs and create service accounts).

---

## 2. Get the code

```bash
git clone <this-repo-url> pb-hubspot-integration
cd pb-hubspot-integration
```

---

## 3. Get your API tokens

You need three tokens before deploying. Save them somewhere temporary — they go into Secret Manager in step 9.

### 3a. Productboard API token

1. In Productboard, go to **Settings → Integrations → Public API**.
2. Click **Add New Public API Token**, name it `pb-hubspot-sync`, and copy the token.

### 3b. HubSpot service-key token

1. In HubSpot, go to **Settings → Integrations → Private Apps**.
2. Click **Create a private app**, name it `pb-hubspot-sync`.
3. On the **Scopes** tab, grant **all three** of:
   - `crm.objects.companies.read` – read company records (core sync source)
   - `crm.schemas.companies.read` – read company property metadata for field mapping
   - `crm.objects.owners.read` – resolve owner IDs to emails for PB member fields
4. Click **Create app** and copy the access token.

> Missing `crm.objects.owners.read` is the most common deployment issue. Sync will run but any mapping from a HubSpot owner-id property to a Productboard member field will be skipped with a warning. The Connect tab in the UI probes all three scopes on save and warns you visibly.

### 3c. Google OAuth 2.0 Web Client

1. In the GCP console, go to **APIs & Services → OAuth consent screen** for your project. If it isn't configured yet, set it to **Internal** (Workspace) or **External**, app name `pb-hubspot-sync`, and add your email as the support contact.
2. Go to **APIs & Services → Credentials → + Create Credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Name: `pb-hubspot-sync`.
5. **Authorised redirect URIs**: add a placeholder for now — you'll come back and update this in step 10. Use `http://localhost:5173/auth/google/callback` so the form will save.
6. Click **Create** and copy the **Client ID** and **Client secret**.

### 3d. Generate a session secret

```bash
openssl rand -base64 32
```

Copy the output — this becomes `SESSION_SECRET`.

---

## 4. (Optional but recommended) Test locally first

This catches token issues before they get baked into Cloud Run.

```bash
cp .env.example .env
# Edit .env and fill in PB_API_KEY, HUBSPOT_API_KEY, GOOGLE_CLIENT_ID,
# GOOGLE_CLIENT_SECRET, GOOGLE_ALLOWED_DOMAIN, SESSION_SECRET.
# Leave GCP_* and GCS_JOB_NAME blank for local dev.
# APP_URL stays as http://localhost:5173.

# Add http://localhost:5173/auth/google/callback to the OAuth client's
# authorised redirect URIs in GCP console (you can keep it there permanently).

npm install
npm run dev
```

Open `http://localhost:5173`, sign in with your Workspace account, and step through the **Connect** tab to verify both tokens. If both come back green, you're ready to deploy.

---

## 5. Authenticate gcloud and set the project

```bash
gcloud auth login
gcloud auth configure-docker
gcloud config set project PROJECT_ID
```

Replace `PROJECT_ID` with your actual GCP project ID.

---

## 6. Enable required APIs

Terraform will enable these too, but doing it manually first lets the Docker push in step 7 succeed before Terraform runs.

```bash
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  iam.googleapis.com \
  containerregistry.googleapis.com \
  artifactregistry.googleapis.com
```

---

## 7. Build and push the Docker image

The image must exist in a registry your Cloud Run service can pull from before Terraform creates the service.

```bash
# From the repo root
docker build --platform linux/amd64 -t gcr.io/PROJECT_ID/pb-hubspot-sync:latest .
docker push gcr.io/PROJECT_ID/pb-hubspot-sync:latest
```

Replace `PROJECT_ID` with your project ID.

> The `--platform linux/amd64` flag matters if you're building on an Apple Silicon Mac — Cloud Run runs on x86_64 and will fail to start an arm64 image with a cryptic "exec format error".

> Prefer Artifact Registry over Container Registry? Create a repo with `gcloud artifacts repositories create pb-hubspot-sync --repository-format=docker --location=us-central1`, then tag/push as `us-central1-docker.pkg.dev/PROJECT_ID/pb-hubspot-sync/pb-hubspot-sync:latest`. Update the `image` value in `terraform.tfvars` accordingly.

---

## 8. Configure and apply Terraform

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

```hcl
project_id            = "PROJECT_ID"
region                = "us-central1"
service_name          = "pb-hubspot-sync"
image                 = "gcr.io/PROJECT_ID/pb-hubspot-sync:latest"
app_url               = "https://placeholder.example.com"   # we'll update this in step 10
google_allowed_domain = "yourdomain.com"
google_allowed_emails = ""                                  # optional — overrides domain check
sync_concurrency      = 5
scheduler_schedule    = "0 2 * * *"                         # daily at 02:00
scheduler_timezone    = "UTC"
history_retention_days = 90
```

> `app_url` is a chicken-and-egg problem: Cloud Run gives you the URL only after the service is created. We deploy with a placeholder, capture the real URL, then re-apply. Both passes are non-destructive.

Apply (first pass):

```bash
terraform init
terraform apply
```

Confirm with `yes`. After 2–3 minutes, capture the outputs:

```bash
terraform output service_url
# e.g. https://pb-hubspot-sync-abc123-uc.a.run.app

terraform output scheduler_job_name
# e.g. projects/PROJECT_ID/locations/us-central1/jobs/pb-hubspot-sync-scheduler
```

> If Terraform errors with `Error 409: Database already exists` on `google_firestore_database.default`, your project already has a Firestore database. Import it instead of creating it: `terraform import google_firestore_database.default "(default)"`, then re-run apply.

---

## 9. Populate Secret Manager

Terraform created five empty secret slots. Add a version to each one with your real values.

```bash
echo -n "YOUR_HUBSPOT_TOKEN"    | gcloud secrets versions add HUBSPOT_API_KEY    --data-file=-
echo -n "YOUR_PB_TOKEN"         | gcloud secrets versions add PB_API_KEY         --data-file=-
echo -n "YOUR_SESSION_SECRET"   | gcloud secrets versions add SESSION_SECRET     --data-file=-
echo -n "YOUR_OAUTH_CLIENT_ID"  | gcloud secrets versions add GOOGLE_CLIENT_ID   --data-file=-
echo -n "YOUR_OAUTH_SECRET"     | gcloud secrets versions add GOOGLE_CLIENT_SECRET --data-file=-
```

> The leading `-n` on `echo` matters — it suppresses the trailing newline. A newline inside a token will cause silent auth failures. Use `printf '%s' "..."` if your shell doesn't accept `echo -n`.

Verify each secret has at least one version:

```bash
gcloud secrets list
gcloud secrets versions list HUBSPOT_API_KEY
```

---

## 10. Update OAuth redirect URI and re-apply Terraform

Now that you have the real Cloud Run URL, point OAuth at it.

1. Go to **GCP Console → APIs & Services → Credentials**, open the OAuth client you created in step 3c.
2. Under **Authorised redirect URIs**, add:
   ```
   https://pb-hubspot-sync-abc123-uc.a.run.app/auth/google/callback
   ```
   (use the real URL from `terraform output service_url`)
3. Keep `http://localhost:5173/auth/google/callback` in the list if you want to continue local dev.
4. Click **Save**.

Update `terraform.tfvars` with the real URL:

```hcl
app_url = "https://pb-hubspot-sync-abc123-uc.a.run.app"
```

Re-apply:

```bash
terraform apply
```

This pushes the corrected `APP_URL` env var to Cloud Run. The service redeploys with zero downtime.

---

## 11. Pick up the new secrets

Cloud Run pulls secret versions at container start, so it doesn't see the secret values you wrote in step 9 until the next revision is deployed. The re-apply in step 10 creates a new revision with `app_url`, which simultaneously picks up the secrets. If you skipped the URL change for any reason, force a new revision manually:

```bash
gcloud run services update pb-hubspot-sync \
  --region us-central1 \
  --update-labels=redeploy=$(date +%s)
```

---

## 12. First sign-in and connection check

1. Open the Cloud Run URL in your browser.
2. You'll be redirected to Google sign-in. Use a `@yourdomain.com` Workspace account (or one in `google_allowed_emails`).
3. After sign-in, you land on the admin UI.
4. Go to the **Connect** tab and click **Test connection** for both Productboard and HubSpot. Both should return green.
5. If HubSpot shows a scope warning, return to the HubSpot private app (step 3b), grant the missing scope, copy the new token, push it to Secret Manager (step 9), force a new revision (step 11), and re-test.

---

## 13. Configure field mappings and run a first sync

1. In the admin UI:
   - **Filter Accounts** tab — pick the HubSpot company filter that defines which accounts get synced into Productboard.
   - **Map Fields** tab — map HubSpot company properties to Productboard company fields.
   - **Schedule** tab — set the cron expression (the value flows through to the Cloud Scheduler job that Terraform created).
2. **Settings** tab → enable **Dry run** for the first run.
3. **Sync** tab → **Run now**. Watch the live SSE log. Confirm the row counts match expectations and no errors are red-flagged.
4. Disable Dry run and re-run.
5. Check **History** for the result.

---

## 14. Verify the scheduler is firing

From the GCP console:

```
Cloud Scheduler → pb-hubspot-sync-scheduler → click "Force run"
```

Or from the CLI:

```bash
gcloud scheduler jobs run pb-hubspot-sync-scheduler --location us-central1
```

A new entry should appear in the **History** tab in the UI within ~30 seconds.

---

## 15. Updating the service after deployment

### Code changes

```bash
# Build a new image with a unique tag (use a git SHA — never overwrite :latest in prod)
TAG=$(git rev-parse --short HEAD)
docker build --platform linux/amd64 -t gcr.io/PROJECT_ID/pb-hubspot-sync:$TAG .
docker push gcr.io/PROJECT_ID/pb-hubspot-sync:$TAG

# Update terraform.tfvars: image = "gcr.io/PROJECT_ID/pb-hubspot-sync:abc1234"
cd terraform
terraform apply
```

### Secret rotation

```bash
echo -n "NEW_TOKEN" | gcloud secrets versions add PB_API_KEY --data-file=-
# Force a new revision so Cloud Run pulls the new version
gcloud run services update pb-hubspot-sync --region us-central1 --update-labels=rotated=$(date +%s)
```

### Schedule changes

Use the **Schedule** tab in the UI — the service updates the Cloud Scheduler job via API. No redeploy needed.

---

## 16. Tear down

```bash
cd terraform
terraform destroy
```

This removes the Cloud Run service, Scheduler job, service accounts, IAM bindings, and the (default) Firestore database. **Firestore deletion is irreversible** — back up `syncHistory` and `config` collections first if you care about them. Container images in `gcr.io` are not removed by Terraform; delete them via `gcloud container images delete` if needed.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Cloud Run starts then crashes — `exec format error` | Image built for arm64 on Apple Silicon | Rebuild with `--platform linux/amd64` |
| `terraform apply` fails on `google_firestore_database.default` | Project already has a Firestore DB | `terraform import google_firestore_database.default "(default)"` |
| Sign-in loop or `redirect_uri_mismatch` | OAuth client redirect URI doesn't match `APP_URL` | Add the exact `${APP_URL}/auth/google/callback` to the OAuth client |
| Secret-related env var is empty at runtime | Secret slot exists but no version was added | `gcloud secrets versions add SECRET_NAME --data-file=-` then redeploy |
| HubSpot connection test warns about owners | Token missing `crm.objects.owners.read` | Grant the scope, regenerate token, update Secret Manager, redeploy |
| Sync writes nothing despite green logs | `DRY_RUN=true` is set | Toggle off in the **Settings** tab |
| Scheduler runs but sync doesn't happen | OIDC audience mismatch (rare) | Re-run `terraform apply` to recreate the scheduler job |
| Cloud Run logs show `403 Permission denied` on Secret Manager | The service account lost the `secretAccessor` binding | `terraform apply` re-creates the IAM binding |

Logs are in **Cloud Run → pb-hubspot-sync → Logs**. Filter on `severity>=ERROR` for failures.

---

## Reference: what Terraform creates

- **APIs enabled**: Cloud Run, Firestore, Secret Manager, Cloud Scheduler, IAM
- **Service accounts**: `pb-hubspot-sync-sa` (the running service), `pb-hubspot-sync-sched-sa` (Scheduler invoker)
- **Firestore**: `(default)` database, native mode, in your chosen region
- **Secret Manager**: empty slots for `HUBSPOT_API_KEY`, `PB_API_KEY`, `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- **Cloud Run**: `pb-hubspot-sync` service, public ingress, secrets injected as env vars, startup probe on `/health`, scales 0–3
- **Cloud Scheduler**: `pb-hubspot-sync-scheduler` job posting to `/api/sync/run` with OIDC auth
- **IAM**: service account gets `datastore.user`, `secretmanager.secretAccessor` on each secret, and `cloudscheduler.admin` (so the UI can update the schedule)

See [terraform/main.tf](terraform/main.tf) for the full definition.
