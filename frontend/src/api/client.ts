const API_BASE = "http://localhost:3001";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// Auth
export const getMe = () => request<{ id: number; username: string }>("/auth/me");
export const logout = () => request("/auth/logout", { method: "POST" });
export const getLoginUrl = () => `${API_BASE}/auth/strava`;

// Sync
export const syncActivities = () => request<{ synced: number }>("/api/sync", { method: "POST" });
export const getSyncStatus = () =>
  request<{ lastSync: string | null; activityCount: number }>("/api/sync/status");

export interface SyncLapsByIdResponse {
  synced: number;
  failed: number;
  errors: { activityId: number; error: string }[];
  lapsByActivity: Record<number, AILap[]>;
}

export const syncLapsForActivities = (activityIds: number[]) =>
  request<SyncLapsByIdResponse>("/api/sync/laps/by-id", {
    method: "POST",
    body: JSON.stringify({ activityIds }),
  });

export interface AILap {
  activityId: number;
  lapIndex: number;
  name: string;
  customName: string | null;
  distance: number | null;
  movingTime: number | null;
  averageSpeed: number | null;
  averageHeartrate: number | null;
  maxHeartrate: number | null;
  averageCadence: number | null;
  lapType: string | null;
}

export interface AIActivity {
  id: number;
  name: string;
  sportType: string | null;
  sessionType: string | null;
  trainingCategory: string | null;
  dayOfWeek: string | null;
  startDateLocal: string | null;
  distance: number | null;
  movingTime: number | null;
  averageSpeed: number | null;
  averageHeartrate: number | null;
  maxHeartrate: number | null;
  averageCadence: number | null;
  totalElevationGain: number | null;
  sufferScore: number | null;
  laps: AILap[];
}

// Filtered activities (table data — no AI involvement)
export interface ActivitiesQueryResponse {
  activities: AIActivity[];
  totalMatching: number;
  truncated: boolean;
  maxActivities: number;
  from: string | null;
  to: string | null;
  categories: string[] | null;
}

export interface ActivityFilterOpts {
  categories?: string[];
  from?: string;
  to?: string;
  search?: string;
  sportType?: string;
}

export const fetchFilteredActivities = (opts: ActivityFilterOpts) =>
  request<ActivitiesQueryResponse>("/api/ai/activities", {
    method: "POST",
    body: JSON.stringify({
      categories: opts.categories,
      from: opts.from || undefined,
      to: opts.to || undefined,
      search: opts.search || undefined,
      sportType: opts.sportType || undefined,
    }),
  });

// AI insight scope: either explicit activity IDs (user-selected rows) or the
// filter state itself (server derives IDs). Backend rejects if both missing.
export interface AIInsightRequest {
  question: string;
  activityIds?: number[];
  filters?: ActivityFilterOpts;
}

// AI insight on a specific filtered + selected set of activities
export interface AIInsightResponse {
  answer: string;
  activitiesAnalysed: number;
  truncated: boolean;
  maxActivities: number;
}

export const getAIInsight = (req: AIInsightRequest) =>
  request<AIInsightResponse>("/api/ai/insights", {
    method: "POST",
    body: JSON.stringify(req),
  });

// Activities
export interface Activity {
  id: number;
  name: string;
  sportType: string | null;
  sessionType: string | null;
  startDate: string;
  startDateLocal: string | null;
  dayOfWeek: string | null;
  distance: number | null;
  movingTime: number | null;
  elapsedTime: number | null;
  averageSpeed: number | null;
  averageHeartrate: number | null;
  maxHeartrate: number | null;
  averageCadence: number | null;
  totalElevationGain: number | null;
  sufferScore: number | null;
  trainingCategory: string | null;
  // Only the paginated list endpoint (/api/activities) populates laps; the
  // single-activity endpoint and the /metrics/compare endpoint omit them.
  laps?: AILap[];
}

export interface ActivitiesResponse {
  activities: Activity[];
  page: number;
  total: number;
}

// Params accept arrays (e.g. category) which serialise as repeated query keys.
export const getActivities = (
  params?: Record<string, string | string[] | undefined>
) => {
  const qs = params ? "?" + encodeParams(params) : "";
  return request<ActivitiesResponse>(`/api/activities${qs}`);
};

function encodeParams(params: Record<string, string | string[] | undefined>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) usp.append(key, v);
    } else {
      usp.append(key, value);
    }
  }
  return usp.toString();
}

// Convert a paginated Activity (with laps) into the AIActivity shape that
// CompareModal expects.
export function activityToAI(a: Activity): AIActivity {
  return {
    id: a.id,
    name: a.name,
    sportType: a.sportType,
    sessionType: a.sessionType,
    trainingCategory: a.trainingCategory,
    dayOfWeek: a.dayOfWeek,
    startDateLocal: a.startDateLocal,
    distance: a.distance,
    movingTime: a.movingTime,
    averageSpeed: a.averageSpeed,
    averageHeartrate: a.averageHeartrate,
    maxHeartrate: a.maxHeartrate,
    averageCadence: a.averageCadence,
    totalElevationGain: a.totalElevationGain,
    sufferScore: a.sufferScore,
    laps: a.laps ?? [],
  };
}

export const getActivity = (id: number) => request<Activity>(`/api/activities/${id}`);

export const bulkUpdateCategory = (activityIds: number[], trainingCategory: string | null) =>
  request<{ updated: number }>("/api/activities/bulk-category", {
    method: "POST",
    body: JSON.stringify({ activityIds, trainingCategory }),
  });

export const bulkUpdateCategoryByCriteria = (
  trainingCategory: string,
  filters: {
    name?: string;
    distanceMin?: number;
    distanceMax?: number;
    speedMin?: number;
    speedMax?: number;
  }
) =>
  request<{ updated: number }>("/api/activities/bulk-category-by-criteria", {
    method: "POST",
    body: JSON.stringify({ trainingCategory, filters }),
  });

export const updateActivity = (id: number, data: { trainingCategory?: string | null; name?: string }) =>
  request<{ ok: boolean }>(`/api/activities/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });

export const updateActivityCategory = (id: number, trainingCategory: string | null) =>
  updateActivity(id, { trainingCategory });

// Laps
export interface Lap {
  id: number;
  activityId: number;
  lapIndex: number;
  name: string;
  customName: string | null;
  distance: number | null;
  movingTime: number | null;
  elapsedTime: number | null;
  averageSpeed: number | null;
  averageHeartrate: number | null;
  maxHeartrate: number | null;
  averageCadence: number | null;
  totalElevationGain: number | null;
}

export const getActivityLaps = (id: number) => request<Lap[]>(`/api/activities/${id}/laps`);

export const renameLap = (activityId: number, lapId: number, customName: string | null) =>
  request<Lap>(`/api/activities/${activityId}/laps/${lapId}`, {
    method: "PATCH",
    body: JSON.stringify({ customName }),
  });

// Rules
export interface Rule {
  id: number;
  category: string;
  ruleType: string;
  ruleValue: string;
  priority: number | null;
  enabled: number | null;
}

export const getRules = () => request<Rule[]>("/api/rules");
export const createRule = (data: { category: string; ruleType: string; ruleValue: string; priority?: number }) =>
  request("/api/rules", { method: "POST", body: JSON.stringify(data) });
export const updateRule = (id: number, data: Partial<Rule>) =>
  request(`/api/rules/${id}`, { method: "PUT", body: JSON.stringify(data) });
export const deleteRule = (id: number) =>
  request(`/api/rules/${id}`, { method: "DELETE" });
export const applyRules = () => request<{ applied: number }>("/api/rules/apply", { method: "POST" });
export const applySingleRule = (id: number) => request<{ applied: number }>(`/api/rules/${id}/apply`, { method: "POST" });

// Metrics
export interface MetricPeriod {
  period: string;
  count: number;
  totalDistance: number;
  totalMovingTime: number;
  avgDistance: number;
  avgSpeed: number;
  avgHeartrate: number | null;
  avgElevation: number | null;
}

export const getMetricsSummary = (params?: Record<string, string>) => {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return request<{ periods: MetricPeriod[] }>(`/api/metrics/summary${qs}`);
};

export const compareActivities = (ids: number[]) =>
  request<Activity[]>(`/api/metrics/compare?ids=${ids.join(",")}`);
