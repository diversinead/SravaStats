import { Request, Response, NextFunction } from "express";

// Simple cookie-based session: stores user ID in a signed-ish cookie.
// For a personal app this is sufficient. For production, use express-session.

const COOKIE_NAME = "strava_user_id";

export function setUserCookie(res: Response, userId: number) {
  res.cookie(COOKIE_NAME, String(userId), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
}

export function clearUserCookie(res: Response) {
  res.clearCookie(COOKIE_NAME);
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const userId = req.cookies?.[COOKIE_NAME];
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  (req as any).userId = Number(userId);
  next();
}
