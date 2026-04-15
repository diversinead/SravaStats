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
- **AI:** OpenAI API (`gpt-4.1-mini` for analysis, `gpt-4o-mini` for filter extraction)
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
   - Final result: 4,926 activities classified:
     - easy: 2271, warmup: 957, long: 734, threshold: 441, interval: 255, crosstraining: 235, race: 16, default: 17

4. **Bulk lap sync** (`backend/src/routes/sync.ts`)
   - New endpoint: `POST /api/sync/laps`
   - Syncs laps from Strava for all `sessionType = 'interval'` activities where `lapsSynced = 0`
   - Picks up where it left off if interrupted (safe to re-run)
   - ⚠️ Strava rate limit: 100 requests per 15 min — if it hangs, wait 15 min and re-POST
   - ✅ All 255 interval sessions fully synced

5. **AI query route** (`backend/src/routes/ai.ts`) ✅ Complete & working
   - Endpoint: `POST /api/ai/query`
   - Body: `{ "question": "your question here" }`
   - **Two-stage approach:**
     - Stage 1: `gpt-4o-mini` extracts filters (dayOfWeek, sessionTypes) from the question — cheap
     - Stage 2: DB queried with filters (max 50 activities) — keeps token count low
     - Stage 3: `gpt-4.1-mini` answers the question with filtered enriched data
   - Returns: `{ answer, activitiesAnalysed, filters }`
   - Registered in `index.ts` as `app.use("/api/ai", aiRoutes)`

6. **AI Coach UI** (`frontend/src/pages/Coach.tsx` + `Coach.css`) ✅ Complete & working
   - Route: `/coach`
   - Chat interface with suggestion chips on empty state
   - Typing indicator while waiting for response
   - Renders markdown responses (headers, bold, lists, hr)
   - Shows "Analysed X activities · Filters: ..." metadata per response
   - Styled to match dark theme (`#0f172a` background, `#f97316` orange accent)
   - Added to `App.tsx` routes and `Layout.tsx` nav

---

## Session 2 — AI Query Layer & Chat UI

### What Was Built
- Switched from Anthropic API to OpenAI API (work account blocks Anthropic API credits)
- Two-stage query approach to stay within OpenAI TPM limits
- Full chat UI built and working
- Dark theme CSS matching existing app styles

### Current State
- ✅ Ask natural language questions about training
- ✅ Filters correctly to relevant sessions (day, session type)
- ✅ Breaks down interval reps with pace, HR, distance
- ✅ Trend analysis across sessions

---

## Next Steps (Session 3)

### Immediate
1. **Session detail improvements** — when AI references a session, make it linkable to `/activities/:id`
2. **Conversation history** — currently each query is stateless; add multi-turn conversation so follow-up questions work (e.g. "now compare that to last year")

### Soon After
3. **Session comparison view** — find similar sessions (same sessionType, similar distance) and compare side by side with a table/chart
4. **Map view** — render polylines using Leaflet.js on activity detail page, colour-coded by pace
5. **Trend charts** — pace/HR over time per session type (Recharts already installed)
6. **Threshold lap sync** — currently only `interval` sessions have laps synced; run bulk sync for `threshold` sessions too

### Later (Garmin)
- Garmin Connect adds: running power, HRV, training load, ground contact time, vertical oscillation
- Library: `garminconnect` (npm)
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

# Trigger bulk lap sync (Postman or curl)
# POST http://localhost:3001/api/sync/laps
# Header: Cookie: strava_user_id=28501411

# Test AI query (Postman)
# POST http://localhost:3001/api/ai/query
# Header: Cookie: strava_user_id=28501411
# Body: { "question": "Show me all my Tuesday interval sessions" }
```

## Environment Variables (`backend/.env`)
```
STRAVA_CLIENT_ID=...
STRAVA_CLIENT_SECRET=...
FRONTEND_URL=http://localhost:5173
PORT=3001
OPENAI_API_KEY=sk-proj-...
```

## Auth Flow
- Login: visit `http://localhost:3001/auth/strava` in browser
- Cookie `strava_user_id` is set automatically after OAuth
- All API routes require this cookie (`requireAuth` middleware)
- For Postman: add Header `Cookie: strava_user_id=28501411`
- Strava athlete ID: `28501411`

## API Routes
```
POST /api/sync              — sync latest activities from Strava
GET  /api/sync/status       — last sync time + activity count
POST /api/sync/laps         — bulk sync laps for interval sessions

GET  /api/activities        — list activities (filterable)
GET  /api/activities/:id    — single activity
GET  /api/activities/:id/laps — laps for activity

POST /api/ai/query          — natural language training query

GET  /api/metrics/summary   — aggregated metrics by period
```
