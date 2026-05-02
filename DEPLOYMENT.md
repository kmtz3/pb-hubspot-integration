# Deployment Guide — pb-hubspot-integration on GCP

A step-by-step guide to deploy the Productboard ↔ HubSpot integration service to Google Cloud Platform. Anyone with this repo, a GCP project, a Productboard token, and a HubSpot service token can follow this guide end to end.

The result: a Cloud Run service with a browser-based admin UI, Firestore as the config store, Cloud Scheduler driving recurring syncs (optional), and Secret Manager holding all credentials.

There are two ways to deploy:

- **Path A — Terminal + Terraform** (sections 5–10): scripted, repeatable, version-controlled. Best if you're comfortable on the command line and want infrastructure-as-code.
- **Path B — GCP Console (UI-only)** (sections 5b–10b): all clicks, no Terraform. Best if you prefer the GCP web UI or just need a one-off deploy.

Both paths share sections 1–4 (prerequisites, code, tokens, OAuth client) and 11–14 (first sign-in, Connect tab, scheduling, updates).

---

## 1. Prerequisites

### Shared

- A **GCP project** with billing enabled. Create one at https://console.cloud.google.com/projectcreate. Note the project ID — you'll use it everywhere as `PROJECT_ID`.
- A **Google Workspace domain** for OAuth sign-in restriction (e.g. `acme.com`). Personal `@gmail.com` accounts work too, but the allow-list will need to use specific emails instead of a domain.
- **Owner** or **Editor** role on the project (you need to enable APIs and create service accounts).

### Path A only (terminal)

Install these on your local machine:

| Tool | Why | Install |
|---|---|---|
| **Google Cloud SDK** (`gcloud`) | Authenticate, push images, manage secrets | https://cloud.google.com/sdk/docs/install |
| **Terraform** ≥ 1.6 | Provision Cloud Run, Firestore, Scheduler, IAM | https://developer.hashicorp.com/terraform/install |
| **Docker** | Build the container image | https://docs.docker.com/get-docker/ |
| **Node.js** ≥ 22 | Only needed if you want to run/test locally first | https://nodejs.org/ |
| **Git** | Clone the repo | – |

### Path B only (UI)

- A **GitHub** account with this repo pushed to it (the Cloud Run "Continuous deployment" trigger pulls source from GitHub).
- Nothing installed locally — everything else happens in the browser.

---

## 2. Get the code

```bash
git clone <this-repo-url> pb-hubspot-integration
cd pb-hubspot-integration
```

For Path B, also push the repo to a GitHub account you own (Cloud Run will connect to it in step 7b):

```bash
git remote add origin git@github.com:<your-handle>/pb-hubspot-integration.git
git push -u origin main
```

---

## 3. Get your API tokens

You need three credentials before deploying. Save them somewhere temporary.

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
5. **Authorised redirect URIs**: add a placeholder for now — you'll come back and add the real Cloud Run URL in step 10. Use `http://localhost:5173/auth/google/callback` so the form will save (also useful for local dev).
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

# Path A — Terminal + Terraform

Steps 5–10 below. Skip to **Path B** (sections 5b–10b) if you'd rather click through the GCP console.

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
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com
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

Terraform created three empty secret slots that the service needs at startup. Add a version to each one with the values from step 3.

```bash
echo -n "YOUR_SESSION_SECRET"   | gcloud secrets versions add SESSION_SECRET       --data-file=-
echo -n "YOUR_OAUTH_CLIENT_ID"  | gcloud secrets versions add GOOGLE_CLIENT_ID     --data-file=-
echo -n "YOUR_OAUTH_SECRET"     | gcloud secrets versions add GOOGLE_CLIENT_SECRET --data-file=-
```

> The leading `-n` on `echo` matters — it suppresses the trailing newline. A newline inside a token will cause silent auth failures. Use `printf '%s' "..."` if your shell doesn't accept `echo -n`.

> **HubSpot and Productboard tokens are NOT loaded here.** They go in via the **Connect tab** in the deployed UI (step 11). The app writes them into Secret Manager itself as `hubspot-token` and `productboard-token` and stores the version resource name in Firestore. This means the runtime SA needs `roles/secretmanager.admin` (granted by Terraform) so it can create those secrets on first connect.

Verify each secret has at least one version:

```bash
gcloud secrets list
gcloud secrets versions list SESSION_SECRET
```

---

## 10. Update OAuth redirect URI and re-apply Terraform

Now that you have the real Cloud Run URL, point OAuth at it.

1. Go to **GCP Console → APIs & Services → Credentials**, open the OAuth client you created in step 3c.
2. Under **Authorised redirect URIs**, add (no trailing slash):
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

This pushes the corrected `APP_URL` env var to Cloud Run. The service redeploys with zero downtime, picking up the secret versions you wrote in step 9.

Skip ahead to **Section 11**.

---

# Path B — GCP Console (UI-only)

Steps 5b–10b below. All clicks, no terminal beyond the one `openssl` command in 3d.

---

## 5b. Confirm the project and enable APIs

1. Open https://console.cloud.google.com/ and select your project from the picker at the top.
2. Go to **APIs & Services → Library**. Search and **Enable** each of these (one click each):
   - **Cloud Run Admin API**
   - **Cloud Build API**
   - **Firestore API**
   - **Secret Manager API**
   - **Cloud Scheduler API** (only needed if you want recurring syncs)
   - **IAM API**
   - **Artifact Registry API**

Each takes ~10 seconds. You can do this in parallel tabs.

---

## 6b. Create the Firestore database

1. Go to **Firestore** in the console (search "Firestore" in the top bar).
2. Click **Create database**.
3. **Mode**: Native mode.
4. **Location**: `eur3 (europe-west)` or a single-region close to you (e.g. `europe-west1`). This is permanent — match your intended Cloud Run region.
5. **Edition**: Standard.
6. **Database ID**: leave as `(default)`.
7. Security rules don't matter — the server uses the Admin SDK which bypasses rules. You can pick any preset.
8. Click **Create database**. ~30 seconds.

---

## 7b. Create the Cloud Run service from your GitHub repo

1. Go to **Cloud Run** in the console.
2. Click **+ Create service**.
3. Select **Continuously deploy from a repository (source or function)**.
4. Click **Set up with Cloud Build**:
   - **Repository provider**: GitHub. Authenticate if prompted.
   - **Repository**: pick your `pb-hubspot-integration` repo.
   - Click **Next**.
   - **Branch**: `^main$` (or whichever branch you want to auto-deploy).
   - **Build type**: **Dockerfile**.
   - **Source location**: `/Dockerfile` (the default).
   - Click **Save**.
5. Back on the service-create page:
   - **Service name**: `pb-hubspot-integration`.
   - **Region**: same region as Firestore (e.g. `europe-west1`).
   - **Authentication**: **Allow unauthenticated invocations** (the app does its own Google sign-in gate; Cloud Run-level auth would block the OAuth dance).
   - **CPU allocation**: **CPU is only allocated during request processing**.
   - **Minimum / Maximum instances**: 0 / 3 (or your preference).
6. Expand **Container, Networking, Security → Variables & Secrets** and add the env vars listed in **section 8b** below. (You can also do this after the first deploy and redeploy a new revision.)
7. Click **Create**.

The first build takes ~3–5 minutes. When it completes, the service URL appears at the top of the page (e.g. `https://pb-hubspot-integration-135544167760.europe-west1.run.app`).

> If the first build fails with `unable to evaluate symlinks in Dockerfile path: lstat /workspace/Dockerfile: no such file or directory`, the Dockerfile isn't on the branch you pointed at. Push your code (including the Dockerfile) to that branch and the build will retry on the next push.

---

## 8b. Configure environment variables on Cloud Run

Cloud Run → `pb-hubspot-integration` → **Edit & Deploy New Revision** → **Variables & Secrets** tab.

### Plain env vars

Add each of these under **+ Add Variable**:

| Name | Value |
|---|---|
| `APP_URL` | the Cloud Run URL from step 7b — exactly, no trailing slash, e.g. `https://pb-hubspot-integration-135544167760.europe-west1.run.app` |
| `GOOGLE_ALLOWED_DOMAIN` | `productboard.com` (or your Workspace domain) |
| `GOOGLE_ALLOWED_EMAILS` | leave blank, or a comma-separated allowlist if you want to restrict beyond domain |
| `FIRESTORE_PROJECT_ID` | your GCP project ID, e.g. `pb-tools` |
| `GCP_PROJECT_ID` | same as above (used by the Secret Manager helper to construct resource names) |
| `SYNC_CONCURRENCY` | `5` (default) |
| `DRY_RUN` | `false` |
| `LOG_LEVEL` | `info` |

> **Do NOT set** `NODE_ENV` — the Dockerfile already sets it to `production`. Setting it elsewhere disables the static client serving and the Secure-cookie path.

> **Do NOT set** `FIRESTORE_EMULATOR_HOST` — that's local-emulator only.

### Secret-backed env vars

These three need to be created as Secret Manager secrets first, then mounted. Workflow:

1. **Create the secret**: GCP Console → **Security → Secret Manager** → **+ Create Secret**:
   - Name: `SESSION_SECRET`
   - Secret value: paste the output of `openssl rand -base64 32` from step 3d
   - Replication: **Automatic**
   - Click **Create secret**.
2. Repeat for `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` using the values from step 3c.
3. Back on Cloud Run → Edit & Deploy New Revision → Variables & Secrets → **+ Reference a secret**:
   - **Name**: `SESSION_SECRET` (env var name inside the container)
   - **Secret**: pick `SESSION_SECRET`
   - **Reference method**: **Exposed as environment variable**
   - **Version**: `latest`
4. Repeat for `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

> **HubSpot and Productboard tokens are NOT configured here.** You'll add them via the deployed app's Connect tab in step 11. The app writes them into Secret Manager itself (creates `hubspot-token` and `productboard-token` secrets on first save).

Click **Deploy** at the bottom. The new revision builds in ~30 seconds.

---

## 9b. Grant IAM roles to the runtime service account

Cloud Run runs your container as a service account. By default that's the **Compute Engine default service account** of your project, e.g. `135544167760-compute@developer.gserviceaccount.com`. It needs three roles to function:

1. GCP Console → **IAM & Admin → IAM**.
2. Find the row for the Compute Engine default service account. Click the pencil icon.
3. Click **+ ADD ANOTHER ROLE** and add each of:
   - **Cloud Datastore User** (`roles/datastore.user`) — read/write Firestore (Native mode is exposed via the Datastore API).
   - **Secret Manager Admin** (`roles/secretmanager.admin`) — create secrets, add versions, and read versions. The app needs create + add because the Connect tab writes new tokens into Secret Manager at runtime; you can scope this down later to a custom role with `secretmanager.secrets.create`, `secretmanager.versions.add`, `secretmanager.versions.access`, `secretmanager.secrets.get` if you want least-privilege.
   - **Cloud Scheduler Admin** (`roles/cloudscheduler.admin`) — only needed if you wire up the optional Cloud Scheduler integration (step 13). Skip otherwise.
4. Click **Save**.

---

## 10b. Add the OAuth redirect URI

Now that the Cloud Run URL exists, point OAuth at it.

1. GCP Console → **APIs & Services → Credentials**, open the OAuth client you created in step 3c.
2. Confirm **Application type** at the top of the page reads **Web application**. If not, you need to create a new Web client and update `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in Secret Manager.
3. Under **Authorised redirect URIs**, click **+ ADD URI** and type (no trailing slash, no spaces):
   ```
   https://pb-hubspot-integration-135544167760.europe-west1.run.app/auth/google/callback
   ```
   Use the actual URL from your service.
4. Keep `http://localhost:5173/auth/google/callback` in the list if you want to continue local dev.
5. Click **Save** at the bottom of the page. Wait ~60 seconds for propagation.

> If you later see `Error 400: redirect_uri_mismatch`, the most common cause is a hidden character from copy-paste. Delete the entry, save, refresh, and re-add by typing it manually.

---

# Both paths converge here

---

## 11. First sign-in and connection check

1. Open the Cloud Run URL in your browser (incognito recommended, to avoid stale cookies).
2. You'll be redirected to Google sign-in. Use a `@yourdomain.com` Workspace account (or one in `GOOGLE_ALLOWED_EMAILS`).
3. After sign-in you land on the admin UI. The header chip should match your `package.json` version.
4. Go to the **Connect** tab.
5. Paste the **Productboard token** from step 3a. Click **Connect**. The app:
   - validates the token by calling Productboard's `/users/me`,
   - writes the token to Secret Manager as a new version of `productboard-token`,
   - stores the resource name (e.g. `projects/PROJECT_ID/secrets/productboard-token/versions/1`) in Firestore.
6. Paste the **HubSpot token** from step 3b. Click **Connect**. Same flow, into `hubspot-token`. The Connect-tab card surfaces all three required scopes — confirm each is green.
7. Click **Test connection** on both. Both should return `ok` with portal/workspace info.

After both are connected, go to **GCP Console → Security → Secret Manager**: you should see `hubspot-token` and `productboard-token` listed alongside the secrets from step 9 / 8b.

> Want to verify nothing leaks to the browser? DevTools → Network → `GET /api/connections` → Response. The body should contain `tokenMasked` only — no `tokenSecretName` field, no raw token strings.

---

## 12. Configure field mappings and run a first sync

1. In the admin UI:
   - **Filter Accounts** tab — pick the HubSpot company filter that defines which accounts get synced into Productboard.
   - **Map Fields** tab — map HubSpot company properties to Productboard company fields.
   - **Schedule** tab — set the cron expression (the value flows through to the Cloud Scheduler job, if you wired one up).
2. **Settings** tab → enable **Dry run** for the first run.
3. **Sync** tab → **Run now**. Watch the live SSE log. Confirm the row counts match expectations and no errors are red-flagged.
4. Disable Dry run and re-run.
5. Check **History** for the result.

---

## 13. (Optional) Wire up Cloud Scheduler

Recurring syncs are optional. Skip this section if you only want manual runs.

### Path A: Terraform already created the scheduler job

```bash
gcloud scheduler jobs run pb-hubspot-sync-scheduler --location us-central1
```

A new entry should appear in the **History** tab in the UI within ~30 seconds. The job is configured by the **Schedule** tab in the UI — it updates the cron expression on the Terraform-created job via API.

### Path B: create the scheduler job manually

1. GCP Console → **Cloud Scheduler → + Create job**.
2. Name: `pb-hubspot-sync-scheduler`. Region: same as Cloud Run.
3. Frequency: `0 2 * * *` (or whatever cron you want). Timezone: your choice.
4. Target type: **HTTP**.
5. URL: `https://YOUR-CLOUD-RUN-URL/api/sync/run`.
6. HTTP method: `POST`.
7. Auth header: **Add OIDC token**. Service account: pick or create one named `pb-hubspot-sched-sa`. Audience: leave blank (defaults to the URL).
8. Create the job.
9. On Cloud Run, set env vars:
   - `SCHEDULER_SA_EMAIL`: the service-account email you picked above (e.g. `pb-hubspot-sched-sa@PROJECT_ID.iam.gserviceaccount.com`)
   - `SCHEDULER_OIDC_AUDIENCE`: same as `APP_URL` (only needed if your app URL differs from the OIDC audience)
   - `GCS_JOB_NAME`: `pb-hubspot-sync-scheduler` (so the Schedule tab in the UI can update it)
10. Trigger a test run from the Scheduler page → **Force run**. Confirm the **History** tab shows a new entry.

---

## 14. Updating the service after deployment

### Path A — code changes

```bash
# Build a new image with a unique tag (use a git SHA — never overwrite :latest in prod)
TAG=$(git rev-parse --short HEAD)
docker build --platform linux/amd64 -t gcr.io/PROJECT_ID/pb-hubspot-sync:$TAG .
docker push gcr.io/PROJECT_ID/pb-hubspot-sync:$TAG

# Update terraform.tfvars: image = "gcr.io/PROJECT_ID/pb-hubspot-sync:abc1234"
cd terraform
terraform apply
```

### Path B — code changes

```bash
git push origin main
```

The Cloud Build trigger fires on every push and redeploys the service automatically. Check progress in **GCP Console → Cloud Build → History**.

### Both paths — secret rotation

For session/OAuth secrets:
```bash
echo -n "NEW_SECRET" | gcloud secrets versions add SESSION_SECRET --data-file=-
# Force a new revision so Cloud Run pulls the new version
gcloud run services update pb-hubspot-integration --region europe-west1 --update-labels=rotated=$(date +%s)
```

For HubSpot/Productboard tokens: just go to the **Connect** tab in the UI, click **Disconnect**, and re-paste the new token. The app writes a new version of `hubspot-token` / `productboard-token` and updates Firestore to point at it. The previous version stays accessible in Secret Manager as an audit trail (cheap to retain; disable / destroy in the console if a token leaked).

### Schedule changes

Use the **Schedule** tab in the UI — the service updates the Cloud Scheduler job via API. No redeploy needed.

---

## 15. Tear down

### Path A

```bash
cd terraform
terraform destroy
```

This removes the Cloud Run service, Scheduler job, service accounts, IAM bindings, and the (default) Firestore database. **Firestore deletion is irreversible** — back up `syncHistory` and `config` collections first if you care about them. Container images in `gcr.io` are not removed by Terraform; delete them via `gcloud container images delete` if needed.

### Path B

In the GCP console, in this order:

1. **Cloud Run → pb-hubspot-integration → Delete**.
2. **Cloud Build → Triggers** — delete the auto-created GitHub trigger.
3. **Cloud Scheduler** → delete `pb-hubspot-sync-scheduler` if you created it.
4. **Secret Manager** → delete each secret (`SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `hubspot-token`, `productboard-token`).
5. **Firestore** → there is no delete-database button in the UI; use `gcloud firestore databases delete --database='(default)'` if needed. **Irreversible.**
6. **IAM** → remove the roles you added in step 9b from the Compute Engine default service account.
7. **APIs & Services → Credentials** → delete the OAuth client.
8. **Artifact Registry** → delete the auto-created `cloud-run-source-deploy` repo if you want to reclaim storage.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Cannot GET /` at the service root | `NODE_ENV` was overridden away from `production`, disabling the static-client mount | Remove any explicit `NODE_ENV` env var on the Cloud Run service |
| Cloud Run starts then crashes — `exec format error` | Image built for arm64 on Apple Silicon (Path A only) | Rebuild with `--platform linux/amd64` |
| Cloud Build fails with `unable to evaluate symlinks in Dockerfile path` | The Dockerfile isn't on the branch the trigger watches | Push your code (including the Dockerfile) to that branch |
| Container fails to start with `Missing auth env vars` | One of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAIN`, `SESSION_SECRET`, `APP_URL` is unset | Add it on Cloud Run (or push it via Terraform) |
| Sign-in loop or `Error 400: redirect_uri_mismatch` | OAuth client redirect URI doesn't byte-match `${APP_URL}/auth/google/callback` | Re-add the URI by typing it manually; check the OAuth client is `Web application` type; check `APP_URL` has no trailing slash |
| Sign-in succeeds but every API call returns 401 | Express isn't trusting the Cloud Run frontend's `X-Forwarded-Proto`, so the `Secure` session cookie is dropped | This is fixed in 1.0.1+ via `app.set('trust proxy', 1)` in `src/server.ts` — make sure you're on a recent commit |
| Every API call returns 500 | Firestore not provisioned, or `FIRESTORE_PROJECT_ID` not set | Create the Firestore database (step 6b) and set the env var to your project ID |
| `Test connection` fails with `PERMISSION_DENIED on resource project pat-eu1-…` | Old code path that fed a literal token to Secret Manager | Pull 1.0.3+; reconnect via the Connect tab |
| Connect tab leaks the raw token in `GET /api/connections` response | Old code path | Pull 1.0.4+; the response now contains only `tokenMasked` |
| HubSpot connection test warns about owners scope | Token missing `crm.objects.owners.read` | Grant the scope in HubSpot, regenerate the token, reconnect via the Connect tab |
| Sync writes nothing despite green logs | `DRY_RUN=true` is set | Toggle off in the **Settings** tab or set `DRY_RUN=false` on Cloud Run |
| Scheduler runs but sync doesn't happen | OIDC audience mismatch | Confirm `SCHEDULER_OIDC_AUDIENCE` (or `APP_URL`) matches the audience the scheduler signs tokens for |
| Cloud Run logs show `403 Permission denied` on Secret Manager | Runtime SA missing `roles/secretmanager.admin` (or accessor) | Grant on IAM page (step 9b) |

Logs are in **Cloud Run → pb-hubspot-integration → Logs**. Filter on `severity>=ERROR` for failures.

---

## Reference: what gets created

### Path A (Terraform)

- **APIs enabled**: Cloud Run, Firestore, Secret Manager, Cloud Scheduler, IAM, Cloud Build
- **Service accounts**: `pb-hubspot-sync-sa` (the running service), `pb-hubspot-sync-sched-sa` (Scheduler invoker)
- **Firestore**: `(default)` database, native mode, in your chosen region
- **Secret Manager**: `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. The app creates `hubspot-token` and `productboard-token` itself on first connect.
- **Cloud Run**: `pb-hubspot-sync` service, public ingress, secrets injected as env vars, startup probe on `/health`, scales 0–3
- **Cloud Scheduler**: `pb-hubspot-sync-scheduler` job posting to `/api/sync/run` with OIDC auth
- **IAM**: service account gets `datastore.user`, `secretmanager.admin`, and `cloudscheduler.admin` (so the UI can update the schedule)

See [terraform/main.tf](terraform/main.tf) for the full definition.

### Path B (UI)

- **APIs enabled**: same as Path A
- **Service accounts**: the project's Compute Engine default SA runs the container; create a separate SA only if you wire up Cloud Scheduler (step 13)
- **Firestore**: `(default)` database, native mode, in `eur3` or your chosen single-region
- **Secret Manager**: `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` created manually; `hubspot-token` and `productboard-token` created by the app on first connect.
- **Cloud Run**: source-built from GitHub via an auto-created Cloud Build trigger
- **Cloud Build**: trigger watching `^main$`, building the Dockerfile, deploying to Cloud Run
- **Cloud Scheduler**: optional; create manually in step 13
- **IAM**: Compute Engine default SA gets `datastore.user`, `secretmanager.admin`, optionally `cloudscheduler.admin`
