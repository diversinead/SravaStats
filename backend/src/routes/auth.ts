import { Router } from "express";
import { getAuthUrl, exchangeToken, upsertUser } from "../services/strava.js";
import { setUserCookie, clearUserCookie, requireAuth } from "../middleware/auth.js";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";

const router = Router();

// Redirect to Strava OAuth
router.get("/strava", (_req, res) => {
  const url = getAuthUrl();
  console.log("Auth redirect URL:", url);
  res.set("Cache-Control", "no-store, no-cache");
  res.redirect(302, url);
});

// OAuth callback
router.get("/strava/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    res.redirect(`${process.env.FRONTEND_URL}?auth_error=${error || "no_code"}`);
    return;
  }

  try {
    const tokenData = await exchangeToken(code as string);
    const userId = upsertUser(tokenData);
    setUserCookie(res, userId);
    res.redirect(`${process.env.FRONTEND_URL}`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.redirect(`${process.env.FRONTEND_URL}?auth_error=exchange_failed`);
  }
});

// Logout
router.post("/logout", (_req, res) => {
  clearUserCookie(res);
  res.json({ ok: true });
});

// Current user
router.get("/me", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const user = db
    .select({
      id: schema.users.id,
      username: schema.users.username,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(user);
});

export default router;
