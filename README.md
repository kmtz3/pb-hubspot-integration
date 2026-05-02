# pb-hubspot-integration

One-way sync from HubSpot company records into Productboard company entities. Runs as a Cloud Run service with a browser-based admin UI for configuration, scheduling, and monitoring.

## What it does

- Pulls HubSpot companies (filtered to your segment) and creates or updates matching Productboard company entities
- Deduplicates by HubSpot company ID (primary) and domain name (fallback)
- Auto-provisions select/multiselect field values in Productboard when new HubSpot enumeration values appear
- Streams live sync progress to the browser via SSE
- Manages its own Cloud Scheduler job – schedule changes in the UI take effect immediately, no GCP console access needed

## Quick start (local dev)

```bash
# Install dependencies
npm install

# Copy env file and fill in your credentials
cp .env.example .env
# Edit .env: add PB_API_KEY, HUBSPOT_API_KEY, Google OAuth vars

# Start the Firestore emulator (separate terminal)
firebase emulators:start --only firestore

# Start the dev server (server + Vite in parallel)
npm run dev
# → Server on :3000, Vite on :5173 with /api proxy
```

Open `http://localhost:5173` and follow the Connect tab to wire up both APIs.

## Running tests

```bash
# Unit tests (mocked, no external services needed)
npm test

# Firestore emulator tests (requires emulator on :8080)
npm run test:firestore

# Integration tests (requires real PB_API_KEY and TEST_INTEGRATION=true)
TEST_INTEGRATION=true npm run test:integration

# Full suite
npm run test:all
```

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full step-by-step (Terraform + UI-only paths). Short version:

```bash
# Build and push the Docker image
docker build --platform linux/amd64 -t gcr.io/YOUR_PROJECT/pb-hubspot-sync:latest .
docker push gcr.io/YOUR_PROJECT/pb-hubspot-sync:latest

# Deploy infrastructure (first time or to update)
cd terraform
cp terraform.tfvars.example terraform.tfvars  # fill in your values
terraform init && terraform apply

# Populate the three platform-level secrets created by Terraform
openssl rand -base64 32 | gcloud secrets versions add SESSION_SECRET --data-file=-
echo -n "YOUR_OAUTH_CLIENT_ID"     | gcloud secrets versions add GOOGLE_CLIENT_ID     --data-file=-
echo -n "YOUR_OAUTH_CLIENT_SECRET" | gcloud secrets versions add GOOGLE_CLIENT_SECRET --data-file=-
```

The HubSpot and Productboard tokens are **not** added via `gcloud`. Open the deployed UI's **Connect** tab and paste each token there — the app writes them as new versions of the `hubspot-token` and `productboard-token` Secret Manager secrets and stores the version resource name in Firestore.

## Architecture

```
Browser (React + Vite)
  ↕ REST + SSE
Express server (Cloud Run)
  ├── /api/connections   – store/test API tokens (Secret Manager)
  ├── /api/config        – read/write sync config (Firestore)
  ├── /api/sync/run      – trigger sync, stream progress via SSE
  ├── /api/sync/runs     – sync history
  ├── /api/hubspot/*     – HubSpot property discovery (cached 1h)
  └── /api/productboard/* – PB field discovery (cached 1h)

Cloud Scheduler → POST /api/sync/run (OIDC auth)

Firestore
  config/{hubspot,productboard,sync,fieldMappings,accountFilter}
  syncHistory/
  cache/

Secret Manager
  Platform (provisioned by Terraform):
    SESSION_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
  Tokens (created by the app on first Connect-tab save):
    hubspot-token, productboard-token
```

## HubSpot token scopes

The `HUBSPOT_API_KEY` (private app / service-account token) must be granted **all three** of the scopes below. The Connect tab probes each scope on save and on every "Test connection" run, and warns in the UI if any are missing.

| Scope | Why it's required |
|---|---|
| `crm.objects.companies.read` | Read HubSpot company records (the core sync source) |
| `crm.schemas.companies.read` | Read company property metadata for field mapping |
| `crm.objects.owners.read` | Resolve owner IDs (`hubspot_owner_id`, `hs_user_ids_of_all_owners`) to emails so they can be synced into PB member / multi-member fields |

If `crm.objects.owners.read` is missing, the sync will still run but any field mapping that targets a PB member field from a HubSpot owner-id property will be skipped (logged as a warning). Grant the scope and re-test the connection to enable those mappings.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Yes | OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth 2.0 client secret |
| `GOOGLE_ALLOWED_DOMAIN` | Yes | Google Workspace domain for sign-in |
| `SESSION_SECRET` | Yes | Session signing secret (`openssl rand -base64 32`) |
| `APP_URL` | Yes | Public URL of this service (used to build the OAuth callback) |
| `FIRESTORE_PROJECT_ID` | Prod | GCP project that owns the Firestore database |
| `GCP_PROJECT_ID` | Prod | GCP project (used by Secret Manager + Cloud Scheduler clients) |
| `GCP_REGION` | Prod | GCP region (default `us-central1`) |
| `GCS_JOB_NAME` | Prod | Cloud Scheduler job id or full resource name — set so the Schedule tab can update the cron expression via API |
| `SCHEDULER_SA_EMAIL` | Prod (if scheduler) | Service account email Cloud Scheduler signs OIDC tokens as. Required when scheduler triggers are enabled |
| `SCHEDULER_OIDC_AUDIENCE` | Prod (optional) | Override the OIDC `aud` claim. Defaults to `APP_URL` when unset |
| `GOOGLE_ALLOWED_EMAILS` | No | Comma-separated allowlist; overrides the domain-only check |
| `FIRESTORE_EMULATOR_HOST` | Dev | Route to local emulator (`127.0.0.1:8080`) |
| `SYNC_CONCURRENCY` | No | Parallel companies per batch (default `5`, range 1–25) |
| `DRY_RUN` | No | Log writes without executing them (`true`/`false`) |
| `PB_API_KEY` | No (dev fallback) | Local-dev fallback for the Productboard token. In production the token is supplied via the Connect tab and stored as the `productboard-token` Secret Manager secret |
| `HUBSPOT_API_KEY` | No (dev fallback) | Same as above for HubSpot — stored as `hubspot-token` in production |

## Key conventions

- **No secrets in code** – all credentials from env vars; startup fails fast if missing
- **Idempotent syncs** – safe to re-run; external IDs detect duplicates
- **DRY_RUN** – set `DRY_RUN=true` to test config without writing to either API
- **TypeScript strict mode** – `"strict": true`; no `any` without a comment
- **PBToolkit first** – before writing any new PB API call, check `~/Projects/pb-tools/PBToolkit/src/routes/` for a tested implementation to copy
