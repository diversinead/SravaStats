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

## Session 3 — Coach page overhaul, per-km splits, rep merging, Compare modal

### Major refactor: AI Coach is now table-first, not chat-first
- **Old flow:** type a question → AI extracts filters → table renders the matched activities + chat answer
- **New flow:** open `/coach` → table loads with active filters → adjust filters live → optionally press "Ask AI" to get insights on the *currently visible* activities
- Filters live above the table:
  - **Date range bar** — From/To date pickers + presets `30d`, `90d`, `1y` (default), `2y`, `All`
  - **Sessions tickbox row** — drives `trainingCategory` filter. Tickboxes (all on by default): `Threshold`, `Interval` (=`Track Workout`), `Easy` (=`Easy Run`), `Recovery` (=`Recovery Run`), `Long` (=`Long Run`), `Pace` (=`Marathon Session`), `Race`. `Cross Training` and `WU/CD` are excluded entirely.
- Server-side activity cap: **500** (was 50). Surfaced in UI when exceeded.

### Per-km comparison via Strava `splits_metric`
- **Problem:** Strava's `/activities/{id}/laps` only returns user-pressed lap-button events. For continuous threshold runs (no manual laps) it returns one lap = whole activity → modal showed "no rep distance matches".
- **Fix:** non-interval sessions now use `splits_metric` from `/activities/{id}` (per-km auto-splits) instead.
- **Storage:** same `laps` table, distinguished by the `lap_type` column:
  - `lap_type = NULL` — user-pressed laps (intervals)
  - `lap_type = 'split'` — per-km auto-split (thresholds, easy, long, race)
- **Synthetic IDs for splits:** `activityId * 1000 + split.split` (deterministic, idempotent).
- **On-demand sync:** Compare modal auto-fires `POST /api/sync/laps/by-id` for any selected non-interval activity, replacing whatever's in the laps table for that activity with fresh splits. Orange "Pulling lap data from Strava…" banner shown during sync. ~1 Strava call per activity, ~1–2 sec for typical 2–10 selection.
- **Backend route branches by sessionType:** `interval` → user-laps via `/laps` endpoint; everything else → splits via activity detail endpoint.

### Rep merge logic for sub-1km laps (`Coach.utils.ts`)
- `mergeConsecutiveEffortLaps` collapses consecutive effort laps into one when the total snaps to a standard rep distance:
  - 3×400m no-rest → one 1200m rep ✓
  - 2×800m no-rest → one mile rep ✓
  - 5×1km threshold splits → stays as 5 separate 1km reps (laps ≥1km are always standalone)
  - 5×300m no-rest = 1500m → falls back to 5 separate reps (no standard distance fits)
- Used by both SessionsTable rep-summary and CompareModal classification.

### Two summary modes for the rep summary column
- **Interval sessions** → bucket-style: `mile x 2: 3:15-3:18` `800m x 5: 3:08-3:15` `400m x 8: 2:55-3:08` (label, count, pace range, no `km/min` suffix; column header carries `(pace km/min)`).
- **Non-interval (threshold/easy/long/race)** → segment-style: `10.38km: 3:17` (continuous) or `3.40km: 3:32 · 3.55km: 3:35 · 3.50km: 3:38` (rep-style with recoveries between).
- Logic in `SessionsTable.tsx` branches on `sessionType`.

### Compare modal (`CompareModal.tsx`)
- Bucket filter chips (`mile (3)`, `800m (15)`, `1k (20)`, etc.) — tick to filter the chart + tables in real time. `All` / `None` quick toggles.
- Auto-syncs missing/wrong lap data on mount per the on-demand splits flow above.
- Empty-state message distinguishes "no laps match standard distance" vs "you've unticked everything".

### Chat-bubble visual upgrade (`Coach.css`)
- Subtle gradient bubble, larger padding, soft shadow.
- Headers: amber `h2` with orange underline rule; muted-orange `h3`; uppercase amber `h4`.
- Custom orange `▸` chevron bullets.
- Inline `code` chips for numbers (e.g. `` `3:35/km` `` — dark bg, orange text).
- Orange-bordered amber-tinted blockquote callouts.
- Markdown parser rewritten as a proper line-by-line state machine (handles headers, lists, hr, blockquotes, paragraphs, inline `code`/**bold**/*italic*).
- AI prompt instructs the model to use TL;DR + emoji-prefixed `##` sections + backticked numbers + at-most-one blockquote.
- Hide/Show + Clear controls sit *above* the bubble (so they're reachable without scrolling long answers).

### Removed
- **Metrics tab** entirely — nav link, `/metrics` route, `pages/Metrics.tsx`, backend `routes/metrics.ts`, `app.use("/api/metrics", ...)`.
- **Save AI answer feature** (built then removed in same session — user decided it wasn't needed once they understood the data flow).

---

## Next Steps (Session 4)

### Immediate
1. **Bulk lap-sync needs splits_metric branching** — `/api/sync/laps` (the bulk endpoint) still uses `fetchActivityLaps` for all session types. To pre-warm splits for ~3000 non-interval activities (so Compare opens instantly without the brief on-demand sync), mirror the by-id branching: call `fetchActivityDetail` and use `splits_metric` for any sessionType !== 'interval'.
2. **Easy/Long lap sync** — currently no easy/long sessions have splits in the DB. They lazy-fill as the user opens them in Compare. Pre-sync via bulk if/when (1) is done.

### Soon After
3. **Session detail improvements** — when AI references a session, make it linkable to `/activities/:id`
4. **Conversation history** — currently each insight is stateless; multi-turn would let follow-ups like "now compare that to last year" work
5. **Map view** — render polylines using Leaflet.js on activity detail page, colour-coded by pace
6. **Trend charts** — pace/HR over time per session type (Recharts already installed)

### Later (Garmin)
- Garmin Connect adds: running power, HRV, training load, ground contact time, vertical oscillation
- Library: `garminconnect` (npm) — currently in deps but service not implemented (`backend/src/services/garmin.ts` references missing module)
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

# Inspect lap-table state by lap_type
node -e "const db=require('better-sqlite3')('data.db'); console.table(db.prepare(\"SELECT lap_type, COUNT(*) AS n FROM laps GROUP BY lap_type\").all())"

# Bulk lap sync — defaults to types interval,threshold,race; pass ?types=easy,long or ?types=all
# POST http://localhost:3001/api/sync/laps
# Header: Cookie: strava_user_id=28501411

# On-demand lap sync (auto-fired by CompareModal; can also call manually)
# POST http://localhost:3001/api/sync/laps/by-id
# Header: Cookie: strava_user_id=28501411
# Body: { "activityIds": [123, 456] }
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
POST /api/sync                — sync latest activities from Strava (incremental)
GET  /api/sync/status         — last sync time + activity count
POST /api/sync/laps           — bulk sync laps. Query: ?types=interval,threshold,race
                                (default) | ?types=easy,long | ?types=all.
                                Currently only pulls user-laps — does NOT yet fetch
                                splits_metric for non-intervals (see Session 4 step 1).
POST /api/sync/laps/by-id     — on-demand sync for a specific list of activities.
                                Body: { activityIds: number[] }. Branches by sessionType:
                                interval → user-laps; else → splits_metric (lap_type='split').
                                Idempotent — replaces existing rows for the activity.
                                Returns { synced, failed, errors, lapsByActivity }.

GET  /api/activities          — list activities (filterable, paginated)
GET  /api/activities/:id      — single activity
GET  /api/activities/:id/laps — laps for activity
PATCH /api/activities/:id     — update name / trainingCategory
POST /api/activities/bulk-category               — set category for explicit ID list
POST /api/activities/bulk-category-by-criteria   — set category by name / distance / speed match

POST /api/ai/activities       — filtered activities for the table.
                                Body: { categories?: string[], from?: YYYY-MM-DD, to?: YYYY-MM-DD }.
                                Returns activities + laps, no AI involvement.
                                Cap: 500 activities (MAX_ACTIVITIES).
POST /api/ai/insights         — AI insight on a chosen set of activities.
                                Body: { question: string, activityIds: number[] }.
                                Re-fetches from DB (security), sends to gpt-4.1-mini.

POST /api/rules               — CRUD on category-classification rules
GET  /api/rules
PUT  /api/rules/:id
DELETE /api/rules/:id
POST /api/rules/apply         — apply all enabled rules to all activities
POST /api/rules/:id/apply     — apply one rule
```

## Schema notes (`backend/src/db/schema.ts`)
- `activities.training_category` is the user's own classification label (e.g. `Threshold`, `Track Workout`, `Easy Run`). Drives the AI Coach tickbox filter.
- `activities.session_type` is the auto-classified type from `classifySession()` (e.g. `interval`, `threshold`, `easy`). Different from trainingCategory; less granular but enum-constrained.
- `activities.laps_synced` (0/1) — flag for bulk-sync resumption.
- `laps.lap_type` — `NULL` for user-pressed lap events, `'split'` for per-km auto-splits from `splits_metric`. Used to distinguish data sources for the same activity.
- Synthetic split lap IDs: `activityId * 1000 + split.split` (deterministic).
