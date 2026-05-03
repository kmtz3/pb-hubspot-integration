# Deployment Guide — pb-hubspot-integration on GCP

A step-by-step guide to deploy the Productboard ↔ HubSpot integration service to Google Cloud Platform. Anyone with this repo, a GCP project, a Productboard token, and a HubSpot service token can follow this guide end to end.

The result: a Cloud Run service with a browser-based admin UI, Firestore as the config store, Cloud Scheduler driving recurring syncs, and Secret Manager holding all credentials — with a Cloud Build trigger on `main` so every merge auto-deploys.

**Ownership split.** Terraform owns the *infrastructure* — Firestore, the Cloud Run service shell, Secret Manager containers, IAM, the Cloud Scheduler job, service accounts. Cloud Build owns the *running image* — a push to `main` builds the Dockerfile, pushes it to Artifact Registry, and rolls a new revision onto Cloud Run. The `cloudbuild.yaml` at the repo root is the deploy pipeline, and the `lifecycle { ignore_changes = […] }` on the Cloud Run resource keeps `terraform apply` from reverting the CD-deployed image.

---

## 1. Prerequisites

- A **GCP project** with billing enabled. Create one at https://console.cloud.google.com/projectcreate. Note the project ID — you'll use it everywhere as `PROJECT_ID`.
- A **Google Workspace domain** for OAuth sign-in restriction (e.g. `acme.com`). Personal `@gmail.com` accounts work too, but the allow-list will need to use specific emails instead of a domain.
- **Owner** or **Editor** role on the project (you need to enable APIs and create service accounts).
- A **GitHub** account with this repo pushed to it — Cloud Build pulls source from GitHub on every commit.

Install these on your local machine:

| Tool | Why | Install |
|---|---|---|
| **Google Cloud SDK** (`gcloud`) | Authenticate, manage secrets, run one-off commands | https://cloud.google.com/sdk/docs/install |
| **Terraform** ≥ 1.6 | Provision Cloud Run, Firestore, Scheduler, IAM | https://developer.hashicorp.com/terraform/install |
| **Node.js** ≥ 22 | Only needed if you want to run/test locally first | https://nodejs.org/ |
| **Git** | Clone the repo | – |

You don't need Docker locally — Cloud Build does the building.

---

## 2. Get the code

```bash
git clone <this-repo-url> pb-hubspot-integration
cd pb-hubspot-integration
```

Push the repo to a GitHub account you own — Cloud Build will connect to it in step 9:

```bash
git remote add origin git@github.com:YOUR_GH_ACCOUNT/pb-hubspot-integration.git
git push -u origin main
```

---

## 3. Get your API tokens

You need three credentials before deploying. Save them somewhere temporary.

### 3a. Productboard API token

1. In Productboard, go to **Settings → Integrations → Public API**.
2. Click **Add New Public API Token**, name it `pb-hubspot-sync`, and copy the token.

### 3b. HubSpot service-key token

HubSpot Service Keys are the recommended path for server-to-server integrations: account-owned (not tied to an individual user) and creatable in the UI without spinning up a private app.

1. In HubSpot, go to **Development → Keys → Service Keys** and click **Create service key** (top right). Requires Super Admin or Developer tools permission.
2. Name it `pb-hubspot-sync`.
3. Click **Add new scope** and grant **all three** of:
   - `crm.objects.companies.read` – read company records (core sync source)
   - `crm.schemas.companies.read` – read company property metadata for field mapping
   - `crm.objects.owners.read` – resolve owner IDs to emails for PB member fields
4. Click **Create**, confirm, and copy the access token.

> Missing `crm.objects.owners.read` is the most common deployment issue. Sync will run but any mapping from a HubSpot owner-id property to a Productboard member field will be skipped with a warning. The Connect tab in the UI probes all three scopes on save and warns you visibly.

### 3c. Google OAuth 2.0 Web Client

1. In the GCP console, go to **APIs & Services → OAuth consent screen** for your project. If it isn't configured yet, set it to **Internal** (Workspace) or **External**, app name `pb-hubspot-sync`, and add your email as the support contact.
2. Go to **APIs & Services → Credentials → + Create Credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Name: `pb-hubspot-sync`.
5. **Authorised redirect URIs**: add a placeholder for now — you'll come back and add the real Cloud Run URL in step 11. Use `http://localhost:3000/auth/google/callback` so the form will save (also useful for local dev — `src/lib/auth.ts` always sends the dev callback on port 3000 regardless of `APP_URL`).
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

# Add http://localhost:3000/auth/google/callback to the OAuth client's
# authorised redirect URIs in GCP console (you can keep it there permanently).
# Note: APP_URL is 5173 (Vite) but the OAuth callback is hardcoded to 3000
# (Express) in dev — see src/lib/auth.ts.

npm install
npm run dev
```

Open `http://localhost:5173`, sign in with your Workspace account, and step through the **Connect** tab to verify both tokens. If both come back green, you're ready to deploy.

---

## 5. Authenticate gcloud and set the project

```bash
gcloud auth login
gcloud auth application-default login   # so terraform can use your creds
gcloud config set project PROJECT_ID
```

Replace `PROJECT_ID` with your actual GCP project ID.

---

## 6. Enable required APIs

```bash
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  iam.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com
```

Terraform will enable these too, but doing it manually first means the secret-population step in 8 doesn't fail on a cold project.

---

## 7. Apply Terraform — pass 1 (secret containers only)

Terraform declares the three Secret Manager secret containers (`SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) but does **not** populate their versions — secret material stays out of Terraform state by design. The Cloud Run service references `version = "latest"` on each secret, so it cannot start until at least one version exists. We solve this with a two-pass apply: pass 1 creates the empty secret containers, you populate them, pass 2 creates Cloud Run.

Configure the inputs:

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

```hcl
project_id            = "PROJECT_ID"
region                = "europe-west1"
service_name          = "pb-hubspot-sync"
# `image` is optional — defaults to Google's hello-world placeholder.
# Cloud Build CD takes over the image attribute on first push to main.
app_url               = "https://placeholder.example.com"   # we'll update this in step 11
google_allowed_domain = "yourdomain.com"
google_allowed_emails = ""                                  # optional — overrides domain check
sync_concurrency      = 5
scheduler_schedule    = "0 2 * * *"                         # daily at 02:00
scheduler_timezone    = "UTC"
history_retention_days = 90
```

> `app_url` is a chicken-and-egg problem: Cloud Run's deterministic URL needs the project number, which we haven't surfaced yet. We deploy with a placeholder, capture the real URL from `terraform output`, then re-apply. Both passes are non-destructive.

Apply only the secret containers:

```bash
terraform init
terraform apply \
  -target=google_project_service.secretmanager \
  -target=google_secret_manager_secret.session_secret \
  -target=google_secret_manager_secret.google_client_id \
  -target=google_secret_manager_secret.google_client_secret
```

Confirm with `yes`. Takes ~30 seconds.

> If a later pass errors with `Error 409: Database already exists` on `google_firestore_database.default`, your project already has a Firestore database. Import it: `terraform import google_firestore_database.default "(default)"`, then re-run apply.

---

## 8. Populate Secret Manager

Add a version to each secret with the values from step 3.

```bash
printf '%s' "YOUR_SESSION_SECRET"   | gcloud secrets versions add SESSION_SECRET       --data-file=-
printf '%s' "YOUR_OAUTH_CLIENT_ID"  | gcloud secrets versions add GOOGLE_CLIENT_ID     --data-file=-
printf '%s' "YOUR_OAUTH_SECRET"     | gcloud secrets versions add GOOGLE_CLIENT_SECRET --data-file=-
```

> `printf '%s'` (no trailing newline) matters — `echo "..."` would append `\n` to the secret value, which silently breaks OAuth. `echo -n "..."` works on bash/zsh but is non-portable.

> **HubSpot and Productboard tokens are NOT loaded here.** They go in via the **Connect tab** in the deployed UI (step 12). The app writes them into Secret Manager itself as `hubspot-token` and `productboard-token` and stores the version resource name in Firestore. This means the runtime SA needs `roles/secretmanager.admin` (granted by Terraform) so it can create those secrets on first connect.

Verify each secret has exactly one version:

```bash
for s in SESSION_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  echo "=== $s ==="; gcloud secrets versions list "$s" --limit=1
done
```

---

## 9. Apply Terraform — pass 2 (everything else)

Now Cloud Run can mount the secrets. Run a full apply:

```bash
terraform apply
```

Confirm with `yes`. After 2–3 minutes, capture the outputs:

```bash
terraform output service_url
# e.g. https://pb-hubspot-sync-135544167760.europe-west1.run.app

terraform output scheduler_job_name
# e.g. projects/PROJECT_ID/locations/europe-west1/jobs/pb-hubspot-sync-scheduler
```

The Cloud Run service will start with Google's hello-world placeholder image (`us-docker.pkg.dev/cloudrun/container/hello`). That's intentional — the next step wires up Cloud Build, and the first `git push` swaps the image to your real one. The hello-world page won't sign you in, so don't try to use the URL until step 10 has succeeded.

> If pass 2 errors on `google_cloud_run_v2_service.sync` with `Secret … was not found`, double-check the secrets exist and have versions. The most common cause is `gcloud secrets versions add` writing to the wrong project. Confirm with `gcloud config get-value project`.

---

## 10. Set up the Cloud Build trigger

This is the only manual step in the GCP console — everything else is `gcloud` or `terraform`. The trigger watches your GitHub repo and runs `cloudbuild.yaml` on every push to `main`.

1. In the GCP console, go to **Cloud Build → Triggers** (region: **`europe-west1`**, top of page).
2. Click **Connect repository**:
   - **Source**: GitHub (Cloud Build GitHub App). Click **Continue** and authorise.
   - **Repository**: pick your `pb-hubspot-integration` repo.
   - Click **Connect**.
3. Click **Create trigger**:
   - **Name**: `pb-hubspot-deploy-main`.
   - **Event**: **Push to a branch**.
   - **Source**: the repository you just connected.
   - **Branch**: `^main$`.
   - **Configuration**: **Cloud Build configuration file (yaml or json)**.
   - **Location**: Repository.
   - **Cloud Build configuration file location**: `/cloudbuild.yaml`.
   - **Service account**: leave as the default Cloud Build SA, OR pick a dedicated SA with `roles/run.developer` + `roles/artifactregistry.writer` + `roles/iam.serviceAccountUser` on the runtime SA. The default SA is fine for one-customer setups.
   - Click **Create**.
4. **Run the trigger once manually** to do the initial deploy: on the trigger row, click **Run** → leave branch as `main` → **Run trigger**.
5. Watch the build at **Cloud Build → History**. It takes ~3–5 minutes the first time (Docker layer cache is empty).

When the build completes, the Cloud Run revision flips from the hello-world placeholder to your real image. From here on, every push to `main` triggers the same pipeline automatically.

> If the first build fails with `unable to evaluate symlinks in Dockerfile path`, the Dockerfile isn't on the branch the trigger watches. Push your code (including the Dockerfile) and `cloudbuild.yaml` to `main` and re-run the trigger.
>
> If the build succeeds but the deploy step errors with `403 Permission denied` on Cloud Run, grant the Cloud Build SA `roles/run.developer`:
> ```bash
> PROJECT_NUMBER=$(gcloud projects describe PROJECT_ID --format='value(projectNumber)')
> gcloud projects add-iam-policy-binding PROJECT_ID \
>   --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
>   --role=roles/run.developer
> gcloud iam service-accounts add-iam-policy-binding \
>   pb-hubspot-sync-sa@PROJECT_ID.iam.gserviceaccount.com \
>   --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
>   --role=roles/iam.serviceAccountUser
> ```

---

## 11. Update OAuth redirect URI and re-apply Terraform

Now that you have the real Cloud Run URL, point OAuth at it.

1. Go to **GCP Console → APIs & Services → Credentials**, open the OAuth client you created in step 3c.
2. Under **Authorised redirect URIs**, add (no trailing slash):
   ```
   https://pb-hubspot-sync-135544167760.europe-west1.run.app/auth/google/callback
   ```
   Use the real URL from `terraform output service_url`.
3. Keep `http://localhost:3000/auth/google/callback` in the list if you want to continue local dev (the dev callback hits Express on `:3000`, not Vite on `:5173` — see `src/lib/auth.ts`).
4. Click **Save**.

Update `terraform.tfvars` with the real URL:

```hcl
app_url = "https://pb-hubspot-sync-135544167760.europe-west1.run.app"
```

Re-apply:

```bash
terraform apply
```

This pushes the corrected `APP_URL` env var to Cloud Run. Cloud Run rolls a new revision with zero downtime; the CD-deployed image stays in place because of the `lifecycle { ignore_changes = [template[0].containers[0].image] }` on the service.

---

## 12. First sign-in and connection check

1. Open the Cloud Run URL in your browser (incognito recommended, to avoid stale cookies).
2. You'll be redirected to Google sign-in. Use a `@yourdomain.com` Workspace account (or one in `GOOGLE_ALLOWED_EMAILS`).
3. After sign-in you land on the admin UI. The header chip shows the version from `package.json` (substituted at server startup — see `src/server.ts`).
4. Go to the **Connect** tab.
5. Paste the **Productboard token** from step 3a. Click **Connect**. The app:
   - validates the token by calling Productboard's `/users/me`,
   - writes the token to Secret Manager as a new version of `productboard-token`,
   - stores the resource name (e.g. `projects/PROJECT_ID/secrets/productboard-token/versions/1`) in Firestore.
6. Paste the **HubSpot token** from step 3b. Click **Connect**. Same flow, into `hubspot-token`. The Connect-tab card surfaces all three required scopes — confirm each is green.
7. Click **Test connection** on both. Both should return `ok` with portal/workspace info.

After both are connected, go to **GCP Console → Security → Secret Manager**: you should see `hubspot-token` and `productboard-token` listed alongside the secrets from step 8.

> Want to verify nothing leaks to the browser? DevTools → Network → `GET /api/connections` → Response. The body should contain `tokenMasked` only — no `tokenSecretName` field, no raw token strings.

---

## 13. Configure field mappings and run a first sync

1. In the admin UI:
   - **Filter accounts** tab — pick the HubSpot company filter that defines which accounts get synced into Productboard.
   - **Map fields** tab — map HubSpot company properties to Productboard company fields.
   - **Schedule** tab — set the cadence (the value flows through to the Cloud Scheduler job that Terraform created in step 9).
2. **Settings** tab → enable **Dry run** for the first run.
3. **Schedule** tab → **Sync now**. Watch the live SSE log. Confirm the row counts match expectations and no errors are red-flagged.
4. Disable Dry run and re-run.
5. Check **History** for the result.

You can manually fire the scheduler job to confirm the OIDC plumbing is correct:

```bash
gcloud scheduler jobs run pb-hubspot-sync-scheduler --location europe-west1
```

A new entry should appear in the **History** tab in the UI within ~30 seconds.

---

## 14. Updates after deployment

### Code changes

```bash
git push origin main
```

The Cloud Build trigger fires on every push to `main`, runs `cloudbuild.yaml` (build → push → deploy), and rolls a new Cloud Run revision. Watch progress at **Cloud Build → History**. Typical build time is 2–3 minutes once the layer cache warms up.

### Schedule changes

Use the **Schedule** tab in the UI — the service updates the Cloud Scheduler job via API. No redeploy needed.

### Infrastructure changes

`terraform apply` updates env vars, IAM bindings, scaling, the scheduler cron, etc. — but never the running image. The image is owned by Cloud Build CD; if you need a manual rollback, do it with `gcloud run services update-traffic`:

```bash
# List recent revisions
gcloud run revisions list --service pb-hubspot-sync --region europe-west1

# Roll back 100% of traffic to a previous revision
gcloud run services update-traffic pb-hubspot-sync \
  --region europe-west1 \
  --to-revisions=pb-hubspot-sync-00012-abc=100
```

### Secret rotation

For session/OAuth secrets:

```bash
printf '%s' "NEW_SECRET" | gcloud secrets versions add SESSION_SECRET --data-file=-
# Force a new revision so Cloud Run pulls the new secret version
gcloud run services update pb-hubspot-sync --region europe-west1 --update-labels=rotated=$(date +%s)
```

For HubSpot/Productboard tokens: just go to the **Connect** tab in the UI, click **Disconnect**, and re-paste the new token. The app writes a new version of `hubspot-token` / `productboard-token` and updates Firestore to point at it. The previous version stays accessible in Secret Manager as an audit trail (cheap to retain; disable / destroy in the console if a token leaked).

---

## 15. Tear down

```bash
cd terraform
terraform destroy
```

This removes the Cloud Run service, Scheduler job, service accounts, IAM bindings, and the (default) Firestore database. **Firestore deletion is irreversible** — back up `syncHistory` and `config` collections first if you care about them.

Then in the console, clean up resources Terraform doesn't track:

1. **Cloud Build → Triggers** — delete `pb-hubspot-deploy-main`.
2. **Artifact Registry** → delete the `cloud-run-source-deploy` repo.
3. **APIs & Services → Credentials** → delete the OAuth client.
4. **Cloud Build → Github connection** → disconnect the GitHub install if you don't reuse it elsewhere.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Cloud Run URL serves Google's "It's running" page | Bootstrap placeholder image is still active — Cloud Build hasn't deployed yet | Run the `pb-hubspot-deploy-main` trigger manually from the Cloud Build console |
| `Cannot GET /` at the service root | `NODE_ENV` was overridden away from `production`, disabling the static-client mount | Remove any explicit `NODE_ENV` env var on the Cloud Run service |
| Cloud Run starts then crashes — `exec format error` | Image built for arm64 (rare with Cloud Build, but possible if you push manually) | Confirm `cloudbuild.yaml` has `--platform=linux/amd64` and re-run the trigger |
| Cloud Build fails with `unable to evaluate symlinks in Dockerfile path` | The Dockerfile isn't on the branch the trigger watches | Push your code (including the Dockerfile + `cloudbuild.yaml`) to `main` |
| Cloud Build deploy step fails with `403 Permission denied` | Cloud Build SA missing `roles/run.developer` or `roles/iam.serviceAccountUser` on the runtime SA | Run the binding commands in step 10's troubleshooting note |
| Container fails to start with `Missing auth env vars` | One of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAIN`, `SESSION_SECRET`, `APP_URL` is unset | Check the env vars on the latest Cloud Run revision — they're declared in `terraform/main.tf` |
| Sign-in loop or `Error 400: redirect_uri_mismatch` | OAuth client redirect URI doesn't byte-match `${APP_URL}/auth/google/callback` | Re-add the URI by typing it manually; check the OAuth client is `Web application` type; check `APP_URL` has no trailing slash |
| Sign-in succeeds but every API call returns 401 | Express isn't trusting the Cloud Run frontend's `X-Forwarded-Proto`, so the `Secure` session cookie is dropped | This is fixed in 1.0.1+ via `app.set('trust proxy', 1)` in `src/server.ts` — make sure you're on a recent commit |
| Every API call returns 500 | Firestore not provisioned | `terraform apply` should have created it; check `terraform state list \| grep firestore` |
| HubSpot Connect-tab card warns about owners scope | Token missing `crm.objects.owners.read` | Grant the scope in HubSpot, regenerate the token, reconnect via the Connect tab |
| Sync writes nothing despite green logs | `DRY_RUN=true` is set | Toggle off in the **Settings** tab or set `DRY_RUN=false` on Cloud Run |
| Scheduler runs but sync doesn't happen | OIDC audience mismatch | Confirm `SCHEDULER_OIDC_AUDIENCE` (defaults to `local.service_url` in main.tf) matches the audience the scheduler signs tokens for |
| Cloud Run logs show `403 Permission denied` on Secret Manager | Runtime SA missing `roles/secretmanager.admin` | `terraform apply` should grant it; check `terraform state list \| grep secret_accessor` |

Logs are in **Cloud Run → pb-hubspot-sync → Logs**. Filter on `severity>=ERROR` for failures. Build logs are in **Cloud Build → History**.

---

## Reference: what gets created

- **APIs enabled**: Cloud Run, Firestore, Secret Manager, Cloud Scheduler, IAM, Artifact Registry, Cloud Build
- **Service accounts**: `pb-hubspot-sync-sa` (the running service), `pb-hubspot-sync-sched-sa` (Scheduler invoker)
- **Firestore**: `(default)` database, native mode, in your chosen region
- **Secret Manager**: `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` declared by Terraform; `hubspot-token` and `productboard-token` created by the app on first connect
- **Cloud Run**: `pb-hubspot-sync` service, public ingress, secrets injected as env vars, startup probe on `/health`, scales 0–3. Image attribute is owned by Cloud Build CD (terraform's `lifecycle { ignore_changes }` lets the CD pipeline update it without `terraform apply` reverting)
- **Cloud Scheduler**: `pb-hubspot-sync-scheduler` job posting to `/api/sync/run` with OIDC auth
- **IAM**: runtime SA gets `datastore.user`, `secretmanager.admin`, `cloudscheduler.admin` (so the UI can update the schedule)
- **Cloud Build**: `pb-hubspot-deploy-main` trigger watching `^main$`, running `cloudbuild.yaml`, pushing images to Artifact Registry repo `cloud-run-source-deploy/pb-hubspot-sync/pb-hubspot-sync`

See [terraform/main.tf](terraform/main.tf) and [cloudbuild.yaml](cloudbuild.yaml) for the full definitions.

---

## Migrating from a manual `gcloud` deploy

If you previously pushed images to `gcr.io/PROJECT_ID/pb-hubspot-sync:latest` (the old Path A flow), they're now orphaned. After confirming the Cloud Build trigger is producing successful deploys:

```bash
PROJECT_ID=your-gcp-project-id

# Confirm the running image is now the CD-built one
gcloud run services describe pb-hubspot-sync --region=europe-west1 \
  --format='value(spec.template.spec.containers[0].image)'
# Expect: europe-west1-docker.pkg.dev/PROJECT_ID/cloud-run-source-deploy/pb-hubspot-sync/pb-hubspot-sync:<sha>

# Then delete every gcr.io tag/digest of the old image
for digest in $(gcloud container images list-tags gcr.io/$PROJECT_ID/pb-hubspot-sync \
  --format='get(digest)'); do
  gcloud container images delete "gcr.io/$PROJECT_ID/pb-hubspot-sync@$digest" \
    --force-delete-tags --quiet
done
```

Storage cost on unreferenced images is ~$0.026/GB/month — pennies — so cleanup is hygiene rather than savings.
