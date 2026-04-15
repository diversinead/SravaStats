import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./db/index.js";

import authRoutes from "./routes/auth.js";
import syncRoutes from "./routes/sync.js";
import activityRoutes from "./routes/activities.js";
import ruleRoutes from "./routes/rules.js";
import aiRoutes from "./routes/ai.js";

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// Run migrations on startup
migrate(db, { migrationsFolder: "./drizzle" });

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// Request logger
app.use((req, _res, next) => {
  console.log(`→ ${req.method} ${req.url}`);
  next();
});


app.get("/auth/test", (_req, res) => {
  console.log("auth/test hit");
  res.json({ ok: true, clientId: process.env.STRAVA_CLIENT_ID });
});

// Routes
app.use("/auth", authRoutes);
app.use("/api/sync", syncRoutes);
app.use("/api/activities", activityRoutes);
app.use("/api/rules", ruleRoutes);
app.use("/api/ai", aiRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
