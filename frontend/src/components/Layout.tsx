import { Link, Outlet, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { getMe, logout, getLoginUrl } from "../api/client";

export default function Layout() {
  const [user, setUser] = useState<{ id: number; username: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    getMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const handleLogout = async () => {
    await logout();
    setUser(null);
    navigate("/");
  };

  if (loading) return <div className="loading">Loading...</div>;

  if (!user) {
    return (
      <div className="login-page">
        <h1>StravaStats</h1>
        <p>Track, tag, and analyze your Strava activities.</p>
        <a href={getLoginUrl()} className="btn btn-primary">
          Connect with Strava
        </a>
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="navbar">
        <Link to="/" className="nav-brand">StravaStats</Link>
        <div className="nav-links">
          <Link to="/">Dashboard</Link>
          <Link to="/activities">Activities</Link>
          <Link to="/rules">Rules</Link>
          <Link to="/metrics">Metrics</Link>
          <Link to="/coach">AI Coach</Link>
        </div>
        <div className="nav-user">
          <span>{user.username}</span>
          <button onClick={handleLogout} className="btn btn-sm">Logout</button>
        </div>
      </nav>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
