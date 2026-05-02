import 'dotenv/config';
import express from 'express';
import passport from 'passport';
import path from 'path';
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

const app = express();
// Cloud Run terminates TLS at its frontend and forwards plain HTTP with X-Forwarded-Proto.
// Without this, Express treats the request as insecure and refuses to set Secure session cookies.
app.set('trust proxy', 1);
app.use(express.json());

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
app.use(authRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

if (process.env.NODE_ENV !== 'production') {
  app.get('/docs', (_req, res) => res.sendFile(path.join(__dirname, '../public/docs/index.html')));

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
