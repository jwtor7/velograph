import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type WorkoutSummary } from '../api.ts';
import { fmtDate, fmtDuration, fmtInt, fmtKm, fmtSpeedKmh } from '../chartspec/spec.ts';
import { EmptyState } from '../components/ui.tsx';

/** Ride library (RIDE-001/002): date-listed rides with search and filters. */
export function Library() {
  const [workouts, setWorkouts] = useState<WorkoutSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [routeOnly, setRouteOnly] = useState(false);
  const [minKm, setMinKm] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    api
      .workouts()
      .then((r) => setWorkouts([...r.workouts].sort((a, b) => b.startUtc - a.startUtc)))
      .catch(() => setError(true));
  }, []);

  const filtered = useMemo(() => {
    if (!workouts) return null;
    return workouts.filter((w) => {
      if (from && w.startUtc < Date.parse(`${from}T00:00:00Z`)) return false;
      if (to && w.startUtc > Date.parse(`${to}T23:59:59Z`)) return false;
      if (routeOnly && !w.hasRoute) return false;
      if (minKm && (w.distanceM ?? 0) < Number(minKm) * 1000) return false;
      return true;
    });
  }, [workouts, from, to, routeOnly, minKm]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Rides</h1>
          <div className="page-sub">
            {workouts ? `${workouts.length} imported rides` : 'Loading…'}
          </div>
        </div>
        <Link to="/import" className="btn primary" style={{ textDecoration: 'none' }}>
          Import rides
        </Link>
      </div>

      <div className="card">
        <div className="row">
          <label>
            <span className="field-label">From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <span className="field-label">To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label>
            <span className="field-label">Min distance (km)</span>
            <input
              type="number"
              min="0"
              value={minKm}
              onChange={(e) => setMinKm(e.target.value)}
              style={{ width: 90 }}
            />
          </label>
          <label style={{ alignSelf: 'flex-end', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={routeOnly}
              onChange={(e) => setRouteOnly(e.target.checked)}
            />
            <span className="muted">Has route</span>
          </label>
        </div>
      </div>

      {error && <EmptyState title="The local API is not reachable. Start it with pnpm dev." />}
      {filtered && filtered.length === 0 && (
        <EmptyState
          title="No rides match. Import a Health Auto Export folder or ZIP to get started."
          action={
            <Link to="/import" className="btn primary" style={{ textDecoration: 'none' }}>
              Import rides
            </Link>
          }
        />
      )}
      {filtered && filtered.length > 0 && (
        <div className="card" style={{ padding: 8 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Date</th>
                <th>Duration</th>
                <th>Distance</th>
                <th>Avg speed</th>
                <th>Avg HR</th>
                <th>Climb</th>
                <th>Route</th>
                <th>Quality</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((w) => (
                <tr
                  key={w.id}
                  className="row-link"
                  tabIndex={0}
                  onClick={() => navigate(`/rides/${w.id}`)}
                  onKeyDown={(e) => e.key === 'Enter' && navigate(`/rides/${w.id}`)}
                >
                  <td>{fmtDate(w.startUtc)}</td>
                  <td>{fmtDuration(w.durationS)}</td>
                  <td>
                    {fmtKm(w.distanceM)} <span className="muted">km</span>
                  </td>
                  <td>
                    {fmtSpeedKmh(w.avgSpeedMs)} <span className="muted">km/h</span>
                  </td>
                  <td style={{ color: 'var(--vg-ch-hr)' }}>
                    {fmtInt(w.avgHr)} <span className="muted">bpm</span>
                  </td>
                  <td style={{ color: 'var(--vg-ch-elevation)' }}>
                    {fmtInt(w.elevationGainM)} <span className="muted">m</span>
                  </td>
                  <td>
                    {w.hasRoute ? (
                      <span className="badge ok">GPS</span>
                    ) : (
                      <span className="badge">none</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${w.qualityState === 'ok' ? 'ok' : 'warn'}`}>
                      {w.qualityState}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
