import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getActivity, getActivityLaps, renameLap, type Activity, type Lap } from "../api/client";

function formatDistance(meters: number | null): string {
  if (!meters) return "-";
  if (meters < 1000) return Math.round(meters) + " m";
  return (meters / 1000).toFixed(2) + " km";
}

function formatPace(speedMs: number | null): string {
  if (!speedMs || speedMs === 0) return "-";
  const paceMin = 1000 / 60 / speedMs;
  const mins = Math.floor(paceMin);
  const secs = Math.round((paceMin - mins) * 60);
  return `${mins}:${secs.toString().padStart(2, "0")} /km`;
}

function formatSpeed(speedMs: number | null): string {
  if (!speedMs) return "-";
  return (speedMs * 3.6).toFixed(1) + " km/h";
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "-";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-stat">
      <span className="detail-stat-label">{label}</span>
      <span className="detail-stat-value">{value}</span>
    </div>
  );
}

function LapNameCell({ lap, activityId, onRenamed }: { lap: Lap; activityId: number; onRenamed: (updated: Lap) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(lap.customName || "");
  const [saving, setSaving] = useState(false);

  const displayName = lap.customName || lap.name;

  const save = async () => {
    setSaving(true);
    try {
      const trimmed = value.trim();
      const updated = await renameLap(activityId, lap.id, trimmed || null);
      onRenamed(updated);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setValue(lap.customName || "");
    setEditing(false);
  };

  if (!editing) {
    return (
      <span
        className="lap-name-display"
        onClick={() => { setValue(lap.customName || ""); setEditing(true); }}
        title="Click to rename"
      >
        {displayName}
        {lap.customName && <span className="lap-original-name"> ({lap.name})</span>}
      </span>
    );
  }

  return (
    <span className="lap-name-edit">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") cancel(); }}
        placeholder={lap.name}
        autoFocus
        disabled={saving}
      />
      <button onClick={save} disabled={saving} className="btn btn-sm">Save</button>
      <button onClick={cancel} disabled={saving} className="btn btn-sm">Cancel</button>
    </span>
  );
}

export default function ActivityDetail() {
  const { id } = useParams<{ id: string }>();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [laps, setLaps] = useState<Lap[]>([]);
  const [lapsLoading, setLapsLoading] = useState(false);
  const [lapsError, setLapsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const numId = Number(id);
    getActivity(numId)
      .then(setActivity)
      .catch((e) => setError(e.message));

    setLapsLoading(true);
    getActivityLaps(numId)
      .then(setLaps)
      .catch((e) => setLapsError(e.message))
      .finally(() => setLapsLoading(false));
  }, [id]);

  const handleLapRenamed = (updated: Lap) => {
    setLaps((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
  };

  if (error) {
    return (
      <div className="page">
        <Link to="/activities">&larr; Back to activities</Link>
        <p style={{ marginTop: "1rem", color: "#f87171" }}>Error: {error}</p>
      </div>
    );
  }

  if (!activity) {
    return (
      <div className="page">
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="page">
      <Link to="/activities">&larr; Back to activities</Link>

      <div style={{ marginTop: "1rem", marginBottom: "0.5rem" }}>
        <h1 style={{ marginBottom: "0.25rem" }}>{activity.name}</h1>
        <div style={{ color: "#94a3b8", fontSize: "0.9rem" }}>
          {activity.sportType} &middot; {new Date(activity.startDate).toLocaleDateString(undefined, {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
          {" "}&middot;{" "}
          {new Date(activity.startDate).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
        {activity.trainingCategory && (
          <div style={{ marginTop: "0.5rem", color: "#60a5fa", fontSize: "0.9rem" }}>
            {activity.trainingCategory}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Performance</h2>
        <div className="detail-stats-grid">
          <Stat label="Distance" value={formatDistance(activity.distance)} />
          <Stat label="Moving Time" value={formatDuration(activity.movingTime)} />
          <Stat label="Elapsed Time" value={formatDuration(activity.elapsedTime)} />
          <Stat label="Pace" value={formatPace(activity.averageSpeed)} />
          <Stat label="Speed" value={formatSpeed(activity.averageSpeed)} />
          <Stat label="Elevation Gain" value={activity.totalElevationGain ? `${Math.round(activity.totalElevationGain)} m` : "-"} />
        </div>
      </div>

      <div className="card">
        <h2>Heart Rate & Effort</h2>
        <div className="detail-stats-grid">
          <Stat label="Avg Heart Rate" value={activity.averageHeartrate ? `${Math.round(activity.averageHeartrate)} bpm` : "-"} />
          <Stat label="Max Heart Rate" value={activity.maxHeartrate ? `${Math.round(activity.maxHeartrate)} bpm` : "-"} />
          <Stat label="Cadence" value={activity.averageCadence ? `${Math.round(activity.averageCadence)} spm` : "-"} />
          <Stat label="Suffer Score" value={activity.sufferScore ? String(activity.sufferScore) : "-"} />
        </div>
      </div>

      <div className="card">
        <h2>Laps</h2>
        {lapsLoading && <p style={{ color: "#94a3b8" }}>Loading laps...</p>}
        {lapsError && <p style={{ color: "#f87171" }}>Could not load laps: {lapsError}</p>}
        {!lapsLoading && !lapsError && laps.length === 0 && (
          <p style={{ color: "#94a3b8" }}>No lap data available.</p>
        )}
        {laps.length > 0 && (
          <>
            <p style={{ color: "#64748b", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
              Click a lap name to rename it.
            </p>
            <div style={{ overflowX: "auto" }}>
              <table className="activity-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Name</th>
                    <th>Distance</th>
                    <th>Time</th>
                    <th>Pace</th>
                    <th>Avg HR</th>
                    <th>Max HR</th>
                    <th>Cadence</th>
                    <th>Elev</th>
                  </tr>
                </thead>
                <tbody>
                  {laps.map((lap) => (
                    <tr key={lap.id}>
                      <td>{lap.lapIndex}</td>
                      <td>
                        <LapNameCell
                          lap={lap}
                          activityId={activity.id}
                          onRenamed={handleLapRenamed}
                        />
                      </td>
                      <td>{formatDistance(lap.distance)}</td>
                      <td>{formatDuration(lap.movingTime)}</td>
                      <td>{formatPace(lap.averageSpeed)}</td>
                      <td>{lap.averageHeartrate ? Math.round(lap.averageHeartrate) : "-"}</td>
                      <td>{lap.maxHeartrate ? Math.round(lap.maxHeartrate) : "-"}</td>
                      <td>{lap.averageCadence ? Math.round(lap.averageCadence) : "-"}</td>
                      <td>{lap.totalElevationGain ? `${Math.round(lap.totalElevationGain)} m` : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
