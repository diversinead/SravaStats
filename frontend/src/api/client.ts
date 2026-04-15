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

export interface AIQueryResponse {
  answer: string;
  activitiesAnalysed: number;
  filters: Record<string, unknown>;
  activities: AIActivity[];
}

export const queryAI = (question: string) =>
  request<AIQueryResponse>("/api/ai/query", {
    method: "POST",
    body: JSON.stringify({ question }),
  });

// Activities
export interface Activity {
  id: number;
  name: string;
  sportType: string | null;
  startDate: string;
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
}

export interface ActivitiesResponse {
  activities: Activity[];
  page: number;
  total: number;
}

export const getActivities = (params?: Record<string, string>) => {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return request<ActivitiesResponse>(`/api/activities${qs}`);
};

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
