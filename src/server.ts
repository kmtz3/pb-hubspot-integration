import 'dotenv/config';
import express from 'express';
import passport from 'passport';
import path from 'path';
import { readFileSync } from 'fs';
import { initializeApp, getApps } from 'firebase-admin/app';
import { sessionMiddleware, requireAuth, requireAuthOrScheduler, validateAuthEnv } from './lib/auth';
import authRouter from './routes/auth';
import { router as connectionsRouter } from './routes/connections';
import { router as configRouter } from './routes/config';
import { router as syncRouter } from './routes/sync';
import { router as previewRouter, hsPropertiesRouter, pbFieldsRouter } from './routes/preview';

validateAuthEnv();

if (!getApps().length) {
  initializeApp({ projectId: process.env.FIRESTORE_PROJECT_ID ?? 'demo-local' });
}

// Read the package.json version once at startup. Mirrors PBToolkit's pattern
// (src/server.js:11-15) — keeps the docs version chip in lock-step with
// `package.json` so a `/commit` semver bump is the only edit needed.
//
// Path differs by environment because of the build layout:
//   dev  – __dirname = <project>/src        → ../package.json
//   prod – __dirname = /app/dist/server     → ../../package.json (the
//          Dockerfile copies package.json to /app)
const PKG_PATH = process.env.NODE_ENV === 'production'
  ? path.join(__dirname, '..', '..', 'package.json')
  : path.join(__dirname, '..', 'package.json');

let APP_VERSION = 'unknown';
try {
  APP_VERSION = (JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { version?: string }).version ?? 'unknown';
} catch (e) {
  console.error('[startup] Failed to read version from package.json:', (e as Error).message);
}

// Pre-substitute the docs HTML once at startup. Vite copies `public/docs/`
// to `dist/client/docs/` during build, so the prod path reads from there;
// dev reads the source file directly.
const DOCS_DIR = process.env.NODE_ENV === 'production'
  ? path.join(__dirname, '..', 'client', 'docs')
  : path.join(__dirname, '..', '..', 'public', 'docs');

function loadDocsHtml(file: string): string | null {
  try {
    const html = readFileSync(path.join(DOCS_DIR, file), 'utf8');
    return html.replace(/\{\{VERSION\}\}/g, APP_VERSION);
  } catch (e) {
    console.warn(`[startup] Could not load ${file} from ${DOCS_DIR}:`, (e as Error).message);
    return null;
  }
}

const docsIndexHtml = loadDocsHtml('index.html');

const app = express();
// Cloud Run terminates TLS at its frontend and forwards plain HTTP with X-Forwarded-Proto.
// Without this, Express treats the request as insecure and refuses to set Secure session cookies.
app.set('trust proxy', 1);
app.use(express.json());

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
app.use(authRouter);

app.get('/health', (_req, res) =>
  res.json({ ok: true, gcpProjectId: process.env.GCP_PROJECT_ID ?? null })
);

// Serve docs in both dev and prod with the version chip substituted at
// startup. Registered BEFORE `express.static` below so the dynamic route
// wins over the static file with `{{VERSION}}` literal in it.
app.get(['/docs', '/docs/index.html'], (_req, res) => {
  if (!docsIndexHtml) return res.status(500).send('Docs unavailable');
  res.type('html').send(docsIndexHtml);
});

if (process.env.NODE_ENV !== 'production') {
  // Dev-only client-error logger – writes JSON lines to /tmp/pb-debug.log
  // so render errors caught by the React ErrorBoundary land in a tail-able file.
  // Remove once the bug is diagnosed.
  const fs = require('fs') as typeof import('fs');
  const DEBUG_LOG_PATH = '/tmp/pb-debug.log';
  app.post('/api/debug/log', (req, res) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...req.body }) + '\n';
    fs.appendFile(DEBUG_LOG_PATH, line, () => res.json({ ok: true }));
  });
}

app.use('/api/sync',         requireAuthOrScheduler, syncRouter);
app.use('/api/connections',  requireAuth, connectionsRouter);
app.use('/api/config',       requireAuth, configRouter);
app.use('/api/filters',      requireAuth, previewRouter);
app.use('/api/hubspot',      requireAuth, hsPropertiesRouter);
app.use('/api/productboard', requireAuth, pbFieldsRouter);

if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '../../dist/client');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
export { app };
