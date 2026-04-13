import { useEffect, useState } from "react";
import { getSyncStatus, syncActivities } from "../api/client";

export default function Dashboard() {
  const [status, setStatus] = useState<{ lastSync: string | null; activityCount: number } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const loadStatus = () => {
    getSyncStatus().then(setStatus);
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await syncActivities();
      setSyncResult(`Synced ${result.synced} activities`);
      loadStatus();
    } catch (err: any) {
      setSyncResult(`Error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="page">
      <h1>Dashboard</h1>

      <div className="card">
        <h2>Sync Status</h2>
        {status && (
          <div>
            <p>Total activities: <strong>{status.activityCount}</strong></p>
            <p>Last sync: <strong>{status.lastSync || "Never"}</strong></p>
          </div>
        )}
        <button onClick={handleSync} disabled={syncing} className="btn btn-primary">
          {syncing ? "Syncing..." : "Sync from Strava"}
        </button>
        {syncResult && <p className="sync-result">{syncResult}</p>}
      </div>
    </div>
  );
}
