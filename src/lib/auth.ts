import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import session from 'express-session';
import type { Request, Response, NextFunction } from 'express';

export interface AuthUser {
  email: string;
  name: string;
}

declare global {
  namespace Express {
    interface User extends AuthUser {}
  }
}

const IS_DEV = process.env.NODE_ENV !== 'production';
const OAUTH_CONFIGURED = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

const ALLOWED_DOMAIN = process.env.GOOGLE_ALLOWED_DOMAIN ?? '';
const ALLOWED_EMAILS = process.env.GOOGLE_ALLOWED_EMAILS
  ? process.env.GOOGLE_ALLOWED_EMAILS.split(',').map(e => e.trim().toLowerCase())
  : [];

// Only register the Google strategy when credentials are present.
// In local dev without .env OAuth values, auth is bypassed entirely (see requireAuth below).
if (OAUTH_CONFIGURED) {
  if (!IS_DEV && !process.env.APP_URL) {
    throw new Error('[auth] APP_URL is required in production — cannot construct OAuth callback URL');
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        // In dev, always use localhost regardless of APP_URL so the registered
        // redirect URI in Google Console never needs to change between environments.
        callbackURL: IS_DEV
          ? 'http://localhost:3000/auth/google/callback'
          : `${process.env.APP_URL}/auth/google/callback`,
      },
      (_accessToken, _refreshToken, profile, done) => {
        const email = profile.emails?.[0]?.value?.toLowerCase() ?? '';

        // hd is the hosted domain claim in Google's signed ID token — present for Workspace accounts only.
        // The hd *request parameter* (sent to Google) is a UX hint only and can be stripped by an attacker.
        // This server-side check of the *response* claim is what actually enforces domain restriction.
        const hd: string = (profile as any)._json?.hd ?? '';
        const domainOk = hd === ALLOWED_DOMAIN || email.endsWith(`@${ALLOWED_DOMAIN}`);

        if (!domainOk) return done(null, false);

        // Email allowlist: when set, only these specific accounts can sign in.
        // Unset → any @ALLOWED_DOMAIN Workspace account is permitted.
        if (ALLOWED_EMAILS.length > 0 && !ALLOWED_EMAILS.includes(email)) {
          return done(null, false);
        }

        return done(null, { email, name: profile.displayName ?? email });
      }
    )
  );
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user: AuthUser, done) => done(null, user));

// MemoryStore is intentional for V1 — sessions reset on container restart (admin re-authenticates).
// Upgrade to connect-session-firestore for persistence across Cloud Run instances in V2.
export const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET ?? 'dev-secret-not-for-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
});

// Apply to any route that should only be accessible to authenticated admins.
// In dev without OAuth credentials configured, all requests pass through automatically.
// API routes (Accept: application/json) get a 401; page routes get a Google sign-in redirect.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (IS_DEV && !OAUTH_CONFIGURED) return next();
  if (req.isAuthenticated()) return next();
  if (req.headers.accept?.includes('application/json')) {
    res.status(401).json({ error: 'Authentication required' });
  } else {
    (req.session as any).returnTo = req.originalUrl;
    res.redirect('/auth/google');
  }
}

// In production, fails fast if required auth env vars are missing.
// In dev, logs a warning so the server still starts for local work.
export function validateAuthEnv(): void {
  const required = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_ALLOWED_DOMAIN', 'SESSION_SECRET', 'APP_URL'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length === 0) return;
  if (!IS_DEV) throw new Error(`Missing auth env vars: ${missing.join(', ')}`);
  console.warn(`[auth] Dev mode — OAuth disabled. Missing: ${missing.join(', ')}. All routes are open.`);
}
