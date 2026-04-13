# StravaStats — Dev Log

## Project Goal
Build a personal training analytics app that connects to Strava (and eventually Garmin) to enable:
- Natural language querying of training data ("show me all my Tuesday speed sessions")
- Rep/lap breakdown for interval sessions
- Session comparison over time
- Route mapping with pace overlays
- Fitness trend analysis

## Tech Stack
- **Frontend:** React + TypeScript + Vite (`/frontend`)
- **Backend:** Node.js + TypeScript + Express (`/backend`)
- **ORM:** Drizzle ORM
- **Database:** SQLite (`data.db`) via better-sqlite3
- **AI:** Anthropic Claude API (`claude-opus-4-5`)
- **Auth:** Strava OAuth, httpOnly cookie (`strava_user_id`)

---

## Session 1 — Foundation & Data Layer

### What Was Built
1. **Schema updates** (`backend/src/db/schema.ts`)
   - Added to `activities` table: `dayOfWeek`, `sessionType`, `polyline`, `garminActivityId`, `lapsSynced`
   - Added `garminActivities` table (ready for Garmin integration later)
   - Run `npx drizzle-kit push` from `/backend` to apply

2. **Session classifier** (`backend/src/services/strava.ts`)
   - `classifySession()` function added above `upsertActivities`
   - Uses `trainingCategory` as primary source (athlete's own labels)
   - Falls back to Strava `workout_type`, then name keywords
   - Session types: `easy`, `long`, `interval`, `threshold`, `warmup`, `crosstraining`, `race`, `default`
   - `dayOfWeek` and `polyline` now extracted on every upsert

3. **Backfill script** (`backend/src/backfill.ts`)
   - One-time script to reclassify all existing activities
   - Safe to re-run — never touches `name` or `trainingCategory`
   - Run with: `npx tsx src/backfill.ts` from `/backend`
   - Result: 4,926 activities classified (easy: 2271, warmup: 957, long: 734, threshold: 441, interval: 255, crosstraining: 235, race: 16, default: 17)

4. **Bulk lap sync** (`backend/src/routes/sync.ts`)
   - New endpoint: `POST /api/sync/laps`
   - Syncs laps from Strava for all `sessionType = 'interval'` activities where `lapsSynced = 0`
   - Picks up where it left off if interrupted (safe to re-run)
   - ⚠️ Strava rate limit: 100 requests per 15 min — if it hangs, wait 15 min and re-POST

5. **AI query route** (`backend/src/routes/ai.ts`) ✅ Written, needs wiring up
   - Endpoint: `POST /api/ai/query`
   - Body: `{ "question": "your question here" }`
   - Pulls last 500 activities + all laps, sends to Claude with coaching system prompt
   - Converts m/s to pace, metres to km automatically in the prompt

### Pending From This Session
- [ ] Lap sync still has ~122 interval sessions remaining (hit Strava rate limit)
  - Re-run `POST /api/sync/laps` after rate limit resets (15 min window)
  - Check progress: `SELECT COUNT(*) FROM activities WHERE session_type = 'interval' AND laps_synced = 0;`
- [ ] Register `ai.ts` in `backend/src/index.ts`:
  ```typescript
  import aiRoutes from "./routes/ai.js";
  app.use("/api/ai", aiRoutes);
  ```
- [ ] Test AI query in Postman:
  - POST `http://localhost:3001/api/ai/query`
  - Header: `Cookie: strava_user_id=28501411`
  - Body: `{ "question": "Show me all my Tuesday interval sessions" }`

---

## Next Steps (Session 2)

### Immediate
1. Finish lap sync
2. Wire up and test `ai.ts`
3. Build simple chat UI in frontend (`frontend/src/components/AiChat.tsx`)
   - Text input + submit button
   - Calls `POST /api/ai/query`
   - Displays formatted response

### Soon After
4. **Session detail view** — show a single interval session with rep breakdown table (pace, HR, distance per lap)
5. **Session comparison** — find similar sessions (same sessionType, similar distance) and compare side by side
6. **Map view** — render polylines using Leaflet.js, colour-coded by pace
7. **Trend charts** — pace/HR over time per session type (Recharts)

### Later (Garmin)
- Garmin Connect adds: running power, HRV, training load, ground contact time, vertical oscillation
- Library: `garminconnect` (npm) — `python-garminconnect` equivalent for Node
- New service: `backend/src/services/garmin.ts`
- Link Garmin activities to Strava activities by matching timestamp
- **Hold off until Strava data layer is fully working**

---

## Key Commands

```bash
# Start backend (from /backend)
npm run dev

# Start frontend (from /frontend)  
npm run dev

# Apply schema changes
cd backend && npx drizzle-kit push

# Backfill session types / dayOfWeek / polyline
cd backend && npx tsx src/backfill.ts

# Check lap sync progress
# Run in SQLite: SELECT COUNT(*) FROM activities WHERE session_type = 'interval' AND laps_synced = 0;
```

## Environment Variables (`backend/.env`)
```
STRAVA_CLIENT_ID=...
STRAVA_CLIENT_SECRET=...
FRONTEND_URL=http://localhost:5173
PORT=3001
ANTHROPIC_API_KEY=sk-ant-...
```

## Auth Flow
- Login: visit `http://localhost:3001/auth/strava` in browser
- Cookie `strava_user_id` is set automatically after OAuth
- All API routes require this cookie (`requireAuth` middleware)
- For Postman: add Header `Cookie: strava_user_id=YOUR_STRAVA_ID`
- Strava athlete ID: `28501411`
