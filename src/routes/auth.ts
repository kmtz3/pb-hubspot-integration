import { Router } from 'express';
import passport from 'passport';
import type { Request, Response, NextFunction } from 'express';

const router = Router();

// Initiates the Google OAuth flow. Stores the post-auth destination in the session
// before handing off to Google so it survives the redirect round-trip.
router.get('/auth/google', (req: Request, _res: Response, next: NextFunction) => {
  if (req.query.next) (req.session as any).returnTo = req.query.next;
  next();
}, passport.authenticate('google', {
  scope: ['openid', 'email', 'profile'],
  hd: process.env.GOOGLE_ALLOWED_DOMAIN, // UX hint — shows org accounts on Google's sign-in page
}));

// Google redirects here after the user authenticates. Passport runs the strategy verify
// function (domain + allowlist check) before this handler is reached.
const CLIENT_ORIGIN = process.env.NODE_ENV !== 'production'
  ? `http://localhost:${process.env.VITE_PORT ?? 5173}`
  : '';

router.get(
  '/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/auth/denied' }),
  (req: Request, res: Response) => {
    const returnTo = (req.session as any).returnTo as string | undefined;
    delete (req.session as any).returnTo;
    // Guard against open redirect — only allow same-origin relative paths.
    const safePath = returnTo?.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
    // In dev the callback lands on :3000 (Express), but the UI lives on :5173 (Vite).
    // Prefix with the Vite origin so the browser ends up on the right port.
    res.redirect(`${CLIENT_ORIGIN}${safePath}`);
  }
);

router.get('/auth/logout', (req: Request, res: Response, next: NextFunction) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect(`${CLIENT_ORIGIN}/`);
  });
});

router.get('/auth/denied', (_req: Request, res: Response) => {
  res.status(403).send(
    'Access denied. Your Google account is not authorised to access this application. ' +
    'Contact your administrator to be added to the allowlist.'
  );
});

export default router;
