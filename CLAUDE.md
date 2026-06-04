# pb-hubspot-integration

Integration toolkit for syncing data between Productboard and HubSpot.

## Project purpose

Automates bidirectional sync between Productboard (product roadmap / feedback) and HubSpot (CRM), enabling CS and Sales teams to surface customer requests, deals, and account health without leaving their tool of choice.

## Tech stack

- **Runtime**: Node.js 22+ (TypeScript strict mode)
- **Server**: Express 4 – port **3000** – entry point `src/server.ts`
- **Client**: React 18 + Vite – port **5173** – entry point `src/client/`
- **Auth**: Passport.js + Google OAuth2 (domain-restricted) / API keys via env vars
- **Storage**: Firebase Admin + Firestore, Google Cloud Scheduler, Secret Manager
- **Package manager**: npm
- **APIs**: Productboard REST API, HubSpot REST API
- **Testing**: Jest (unit | firestore | integration projects)
- **Hot reload**: ts-node-dev `--respawn` (server), Vite HMR (client)

## Directory structure

```
pb-hubspot-integration/
├── CLAUDE.md
├── .claude/
│   ├── settings.json              # Project-scoped permissions
│   ├── .env                       # Local only – never commit (see .env.example)
│   ├── .env.example               # Safe to commit – documents expected vars
│   ├── agents/
│   │   ├── api-explorer.md        # Looks up PB/HubSpot API endpoints without hitting live APIs
│   │   └── update-docs.md         # Reconciles CLAUDE.md and README.md against a git diff
│   └── commands/                  # Slash command definitions
│       ├── add-mapper.md
│       ├── commit.md
│       ├── dev.md
│       ├── health.md
│       ├── pre-staging-audit.md
│       ├── sync-check.md
│       └── update-docs.md
├── src/
│   ├── server.ts                  # Express entry point (port 3000)
│   ├── routes/                    # Express route handlers
│   │   ├── auth.ts                # Google OAuth routes (/auth/*)
│   │   ├── config.ts              # Field mapping config CRUD (/api/config)
│   │   ├── connections.ts         # Connection management (/api/connections)
│   │   ├── preview.ts             # Filter preview, HS properties, PB fields (/api/filters, /api/hubspot, /api/productboard)
│   │   └── sync.ts                # Sync trigger + SSE stream (/api/sync)
│   ├── sync/                      # Core sync engine
│   │   ├── engine.ts              # Orchestrates a full sync run
│   │   ├── productboard.ts        # PB API client (companies, fields, field values, members)
│   │   ├── hubspot.ts             # HubSpot API client (companies, properties, owners, scope probes)
│   │   ├── mapper.ts              # Field mapping: HubSpot → PB type coercion + email resolution
│   │   ├── dedup.ts               # Idempotency – HubSpot ID primary, domain fallback
│   │   ├── sanitize.ts            # HTML sanitization for rich-text / description fields
│   │   └── rateLimit.ts           # Header-driven self-throttling + 429 retry/backoff
│   ├── lib/                       # Shared server utilities
│   │   ├── auth.ts                # Passport config, session middleware, requireAuth guard
│   │   ├── firestore.ts           # Firestore client + typed collection helpers
│   │   └── secrets.ts             # Secret Manager client (production only)
│   ├── types/                     # Shared TypeScript types
│   │   ├── productboard.ts
│   │   ├── hubspot.ts
│   │   └── sync.ts
│   └── client/                    # React 18 + Vite frontend
│       ├── App.tsx
│       ├── main.tsx
│       ├── styles.css
│       ├── index.html
│       ├── components/
│       │   ├── Shell.tsx
│       │   ├── ErrorBoundary.tsx
│       │   ├── tabs/              # Connect, FilterAccounts, History, MapFields, Schedule, Settings
│       │   └── ui/                # Badge, Code, InlineAlert, SearchableSelect
│       ├── hooks/
│       │   ├── api.ts             # react-query wrappers for all API calls
│       │   └── useSyncStream.ts   # SSE hook for live sync progress
│       └── constants/
│           └── operators.ts
├── tests/
│   ├── unit/                      # engine, mapper, dedup, rateLimit
│   ├── firestore/                 # config and syncHistory – hit the emulator
│   ├── integration/               # round-trip, dedup, auto-provisioning – hit live APIs
│   └── helpers/                   # emulator setup, test factories
├── terraform/                     # GCP infrastructure (Cloud Run, Scheduler, Secret Manager)
├── planning-docs/                 # Architecture, implementation plans – gitignored, never commit
├── .firebase-data/                # Firestore emulator persistent state – gitignored
├── .env.example                   # App-level env var documentation
├── firebase.json                  # Emulator config (Firestore port 8080, UI port 4000)
├── Dockerfile
├── package.json
├── tsconfig.json
├── tsconfig.server.json
├── tsconfig.client.json
└── vite.config.ts
```

## Git branching strategy

```
feature/* ──┐
            ├──► staging ──► main  (production)
hotfix/*  ──┘
```

- **`staging`** – pre-production gate. All new work lands here first, gets verified, then merges into `main`.
- **`main`** – production only. Merges from `staging` (or emergency hotfixes). No direct feature commits.
- **Never delete `staging`.** It is a permanent branch.
- Pull requests: feature → staging → main.

## Semver versioning

Version lives in `package.json`. Rules:

| Change type | Bump |
|---|---|
| Breaking change – removes/renames a route, changes API contract | MAJOR |
| New feature – new route, new capability | MINOR |
| Bug fix, polish, docs, tests, refactor | PATCH |

Additional rules:
- Version is bumped **only on `staging` or feature branches** – never on `main` (bump already happened upstream)
- A single commit bumps one level; if a commit has both a new feature and bug fixes, bump MINOR (higher wins)
- Never skip versions – increment by 1 only
- PATCH resets to 0 on MINOR bump; MINOR and PATCH reset to 0 on MAJOR bump

## Environment variables

Copy `.env.example` to `.env` – never commit `.env`.

| Variable | Description |
|---|---|
| `NODE_ENV` | `development` or `production` |
| `PORT` | Express port (default `3000`) |
| `PB_API_KEY` | **Local-dev fallback** for the Productboard token. In production the token is supplied via the Connect tab and stored as the `productboard-token` Secret Manager secret; the resource name is recorded in Firestore. The engine prefers this env var when set so local runs don't need a Secret Manager round-trip. |
| `HUBSPOT_API_KEY` | **Local-dev fallback** for the HubSpot service key token. In production the token is supplied via the Connect tab and stored as `hubspot-token` in Secret Manager. Whichever path is used, the token must grant `crm.objects.companies.read`, `crm.schemas.companies.read`, **and** `crm.objects.owners.read` (the last one resolves owner IDs to emails for PB member field mappings). The Connect tab probes all three on save and on every "Test connection" run, and reports per-scope ✓ / ✗ status in the UI. |
| `FIRESTORE_EMULATOR_HOST` | Set to `127.0.0.1:8080` for local dev; omit in production |
| `FIRESTORE_PROJECT_ID` | `demo-local` for emulator; real GCP project ID in production |
| `GCP_PROJECT_ID` | GCP project – required in production for Cloud Scheduler |
| `GCP_REGION` | GCP region (default `us-central1`) |
| `GCS_JOB_NAME` | Cloud Scheduler job name (set after first Terraform deploy) |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Web Client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 client secret |
| `GOOGLE_ALLOWED_DOMAIN` | Restrict sign-in to this Google Workspace domain |
| `GOOGLE_ALLOWED_EMAILS` | Optional comma-separated allowlist; leave blank to allow any `@GOOGLE_ALLOWED_DOMAIN` |
| `SESSION_SECRET` | Express session signing secret (`openssl rand -base64 32`) |
| `APP_URL` | Public service URL – `http://localhost:5173` for dev, Cloud Run URL in production |
| `SCHEDULER_SA_EMAIL` | Service account email of the Cloud Scheduler invoker. Required in production – `requireAuthOrScheduler` accepts a Google-signed OIDC token from this account on `/api/sync/run`. Leave blank in local dev. |
| `SCHEDULER_OIDC_AUDIENCE` | Expected `aud` claim on Cloud Scheduler OIDC tokens – must match what Terraform configured on the scheduler job (typically the Cloud Run service URI). Defaults to `APP_URL` when unset; set explicitly when `APP_URL` is a custom domain. |
| `SYNC_CONCURRENCY` | Companies processed in parallel, 1–25 (default `5`) |
| `DRY_RUN` | Set `true` to log intended writes without calling any API |
| `LOG_LEVEL` | `info`, `debug`, etc. |

## Common commands

```bash
npm install              # Install dependencies
npm run dev              # Full stack: emulator + Express + Vite (hot reload)
npm run dev:server       # Express only (port 3000)
npm run dev:client       # Vite only (port 5173)
npm run dev:emulator     # Firestore emulator – imports .firebase-data on start, exports on exit
npm run emulator:export  # Manual snapshot of running emulator → .firebase-data
npm run build            # Compile TypeScript + Vite bundle
npm run start            # Run compiled server
npm test                 # Unit tests (DRY_RUN=true)
npm run test:firestore   # Firestore emulator tests
npm run test:integration # Integration tests (hits live APIs)
npm run test:all         # All three suites in order
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit (server + client tsconfigs)
```

## Slash commands

| Command | What it does |
|---|---|
| `/dev` | Kill ports 3000 + 5173, restart full dev stack, verify both listening |
| `/health` | Hit `GET /health` on the Express server, report up/down |
| `/commit` | Diff changes, determine semver bump, edit package.json, stage + commit |
| `/pre-staging-audit` | Consistency + security audit of all files changed vs main |
| `/sync-check` | List recent sync errors, mismatched records, and pending retries |
| `/add-mapper` | Scaffold a new field mapper between a PB entity and a HubSpot object |
| `/update-docs [ref]` | Diff code vs a git ref, identify stale doc sections, and write targeted updates to CLAUDE.md and README.md |

## Agents

| Agent | File | Purpose |
|---|---|---|
| `api-explorer` | `.claude/agents/api-explorer.md` | Look up PB or HubSpot API endpoints, required fields, rate limits – no live API calls |
| `update-docs` | `.claude/agents/update-docs.md` | Reconcile CLAUDE.md and README.md against a git diff – directory tree, env var table, commands table, agents table |

## Key conventions

- **No secrets in code** – all credentials from env vars; fail fast if missing at startup
- **Idempotent syncs** – every sync operation must be safe to re-run; use external IDs to detect duplicates
- **Error handling at boundaries** – validate API responses, surface errors with context (which record, which direction)
- **Dry-run flag** – all write operations must respect `DRY_RUN=true`
- **TypeScript strict mode** – `"strict": true` in tsconfig; no `any` without a comment explaining why
- **`planning-docs/`** – architecture, implementation plans, design guides; never committed (gitignored)
- **`implementation_notes/`** – legacy local planning docs; never committed (gitignored)

## Productboard API reference – use PBToolkit first

Before writing any Productboard API call, check PBToolkit for an existing, tested implementation:

```
~/Projects/pb-tools/PBToolkit
├── src/routes/          # Tested route handlers – source of truth for call structure
│   ├── companies.js     # Company / account endpoints
│   ├── entities.js      # Features, components, products
│   ├── feedback.js      # Feedback / notes ingestion
│   ├── notes.js         # Note CRUD
│   ├── users.js         # User & member lookups
│   └── ...              # Check here before writing a new call from scratch
└── openapi v2 public API/   # Official schema definitions per entity type
    ├── entities.yaml
    ├── notes.yaml
    ├── members.yaml
    └── ...
```

**Rules:**
- **Route structure** – copy the request shape (method, path, headers, body) from the matching `src/routes/*.js` file; these are tested against the live API
- **Field names & types** – validate against the matching `openapi v2 public API/*.yaml` before mapping to HubSpot fields
- **Unknown endpoints** – if no route file exists, check the OpenAPI spec first, then fall back to `developer.productboard.com` docs; note the gap in a code comment
- The PBToolkit path above resolves to the same iCloud Drive tree on any machine with this project synced – adjust if your local path differs

## API rate limits

- Productboard: 300 req/min per token
- HubSpot: 100 req/10s (free), 150 req/10s (paid) – check tier before setting intervals

## What Claude should do

- **Check PBToolkit before writing any PB API call** – `~/Projects/pb-tools/PBToolkit/src/routes/` has tested implementations; reuse the call shape
- Prefer small, composable functions over large classes
- Write tests alongside new sync logic (Jest)
- Check for existing mappers in `src/sync/mapper.ts` before creating new ones
- Validate that external IDs are preserved across sync cycles

## Doc style

- Use spaced en dashes ( – ) in prose, never em dashes ( – )

## What Claude should NOT do

- Hard-code API endpoints – use constants defined in the relevant `src/routes/` or `src/sync/` module
- Add retry logic without exponential backoff + jitter
- Log raw API responses (may contain PII)
- Commit anything in `.env`, `planning-docs/`, `implementation_notes/`, or files matching `*.key`, `*.pem`
- Bump version on `main` – it was already bumped on staging
