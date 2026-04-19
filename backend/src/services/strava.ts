import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";

const STRAVA_API = "https://www.strava.com/api/v3";
const STRAVA_AUTH = "https://www.strava.com/oauth";

interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete: {
    id: number;
    username: string;
    firstname: string;
    lastname: string;
  };
}

interface StravaActivity {
  id: number;
  name: string;
  sport_type: string;
  start_date: string;
  elapsed_time: number;
  moving_time: number;
  distance: number;
  total_elevation_gain: number;
  average_speed: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  suffer_score?: number;
  start_date_local?: string;
  workout_type?: number; // 0=default, 1=race, 2=long run, 3=workout (runs); 10=default, 11=race, 12=workout (rides)
  timezone?: string;
  start_latlng?: [number, number];
}

export function getAuthUrl(): string {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const redirectUri = `http://localhost:${process.env.PORT || 3001}/auth/strava/callback`;
  return `${STRAVA_AUTH}/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read,activity:read_all&approval_prompt=auto`;
}

export async function exchangeToken(code: string): Promise<StravaTokenResponse> {
  const res = await fetch(`${STRAVA_AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava token exchange failed: ${res.status} ${text}`);
  }

  return res.json() as Promise<StravaTokenResponse>;
}

export async function refreshAccessToken(userId: number): Promise<string> {
  const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) throw new Error("User not found");

  // If token hasn't expired, return it
  if (user.tokenExpiresAt > Math.floor(Date.now() / 1000)) {
    return user.accessToken;
  }

  const res = await fetch(`${STRAVA_AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: user.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(`Strava token refresh failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };

  db.update(schema.users)
    .set({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenExpiresAt: data.expires_at,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.users.id, userId))
    .run();

  return data.access_token;
}

export async function fetchActivities(
  userId: number,
  page = 1,
  perPage = 100,
  after?: number
): Promise<StravaActivity[]> {
  const token = await refreshAccessToken(userId);

  const params = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
  });
  if (after) params.set("after", String(after));

  const res = await fetch(`${STRAVA_API}/athlete/activities?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Strava API error: ${res.status}`);
  }

  return res.json() as Promise<StravaActivity[]>;
}

export interface StravaLap {
  id: number;
  name: string;
  lap_index: number;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  average_speed: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  total_elevation_gain: number;
  split: number;
}

export async function fetchActivityLaps(
  userId: number,
  activityId: number
): Promise<StravaLap[]> {
  const token = await refreshAccessToken(userId);

  const res = await fetch(`${STRAVA_API}/activities/${activityId}/laps`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Strava API error: ${res.status}`);
  }

  return res.json() as Promise<StravaLap[]>;
}

// Strava's per-km auto-split, returned by the /activities/{id} detail
// endpoint (NOT the /laps endpoint, which only contains user-pressed laps).
// One entry per km of the activity, populated even when the athlete didn't
// manually lap their watch — exactly what we need for per-km comparison of
// continuous threshold / tempo / easy runs.
export interface StravaSplit {
  distance: number;        // metres (typically 1000)
  elapsed_time: number;
  moving_time: number;
  split: number;           // 1-based index
  average_speed: number;
  average_heartrate?: number;
  pace_zone?: number;
}

interface StravaActivityDetail {
  id: number;
  laps?: StravaLap[];
  splits_metric?: StravaSplit[];
  splits_standard?: StravaSplit[];
}

export async function fetchActivityDetail(
  userId: number,
  activityId: number
): Promise<StravaActivityDetail> {
  const token = await refreshAccessToken(userId);
  const res = await fetch(`${STRAVA_API}/activities/${activityId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Strava API error: ${res.status}`);
  }
  return res.json() as Promise<StravaActivityDetail>;
}

export function upsertUser(tokenData: StravaTokenResponse) {
  const { athlete, access_token, refresh_token, expires_at } = tokenData;

  db.insert(schema.users)
    .values({
      id: athlete.id,
      username: athlete.username || `${athlete.firstname} ${athlete.lastname}`,
      accessToken: access_token,
      refreshToken: refresh_token,
      tokenExpiresAt: expires_at,
    })
    .onConflictDoUpdate({
      target: schema.users.id,
      set: {
        username: athlete.username || `${athlete.firstname} ${athlete.lastname}`,
        accessToken: access_token,
        refreshToken: refresh_token,
        tokenExpiresAt: expires_at,
        updatedAt: new Date().toISOString(),
      },
    })
    .run();

  return athlete.id;
}

function classifySession(a: StravaActivity & { trainingCategory?: string }): string {
  // Maps the 11-value trainingCategory enum to a small set of sessionType
  // buckets used for the coloured pill + table grouping.
  const cat = a.trainingCategory?.toLowerCase() ?? '';
  if (cat.includes('easy') || cat.includes('recovery') || cat.includes('heat') || cat.includes('treadmill')) return 'easy';
  if (cat.includes('long') || cat.includes('marathon')) return 'long';
  if (cat.includes('threshold')) return 'threshold';
  if (cat.includes('interval')) return 'interval';
  if (cat === 'wu/cd' || cat.includes('wu') || cat.includes('cd')) return 'warmup';
  if (cat.includes('cross')) return 'crosstraining';
  if (cat.includes('race')) return 'race';
  // fallback to Strava's workout_type when the athlete hasn't categorised the session yet
  if (a.workout_type === 1) return 'race';
  if (a.workout_type === 2) return 'long';
  if (a.workout_type === 3) return 'interval';
  return 'default';
}

export function upsertActivities(userId: number, activities: StravaActivity[]) {
  let inserted = 0;
  for (const a of activities) {
    db.insert(schema.activities)
      .values({
        id: a.id,
        userId,
        name: a.name,
        sportType: a.sport_type,
        startDate: a.start_date,
        startDateLocal: a.start_date_local ?? null,
        elapsedTime: a.elapsed_time,
        movingTime: a.moving_time,
        distance: a.distance,
        totalElevationGain: a.total_elevation_gain,
        averageSpeed: a.average_speed,
        averageHeartrate: a.average_heartrate ?? null,
        maxHeartrate: a.max_heartrate ?? null,
        averageCadence: a.average_cadence ?? null,
        sufferScore: a.suffer_score ?? null,
        workoutType: a.workout_type ?? null,
        timezone: a.timezone ?? null,
        startLatlng: a.start_latlng ? JSON.stringify(a.start_latlng) : null,
        rawJson: JSON.stringify(a),
        dayOfWeek: new Date(a.start_date).toLocaleDateString('en-AU', { weekday: 'long' }),
        polyline: (a as any).map?.summary_polyline ?? null,
        sessionType: classifySession(a),
      })
      .onConflictDoUpdate({
        target: schema.activities.id,
        set: {
          name: a.name,
          sportType: a.sport_type,
          startDate: a.start_date,
          startDateLocal: a.start_date_local ?? null,
          elapsedTime: a.elapsed_time,
          movingTime: a.moving_time,
          distance: a.distance,
          totalElevationGain: a.total_elevation_gain,
          averageSpeed: a.average_speed,
          averageHeartrate: a.average_heartrate ?? null,
          maxHeartrate: a.max_heartrate ?? null,
          averageCadence: a.average_cadence ?? null,
          sufferScore: a.suffer_score ?? null,
          workoutType: a.workout_type ?? null,
          timezone: a.timezone ?? null,
          startLatlng: a.start_latlng ? JSON.stringify(a.start_latlng) : null,
          rawJson: JSON.stringify(a),
          dayOfWeek: new Date(a.start_date).toLocaleDateString('en-AU', { weekday: 'long' }),
          polyline: (a as any).map?.summary_polyline ?? null,
          sessionType: classifySession(a),
          syncedAt: new Date().toISOString(),
        },
      })
      .run();
    inserted++;
  }
  return inserted;
}


