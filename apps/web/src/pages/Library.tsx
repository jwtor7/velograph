import { useEffect, useMemo, useState } from 'react';
import { api, type WorkoutSummary } from '../api.ts';
import { fmtDate, fmtDuration, fmtInt, fmtKm, fmtSpeedKmh } from '../chartspec/spec.ts';
import { ConfirmDialog, EmptyState } from '../components/ui.tsx';
import { Link, useNavigate } from '../router.tsx';

/** Ride library (RIDE-001/002): date-listed rides with search and filters. */
export function Library() {
  const [workouts, setWorkouts] = useState<WorkoutSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [routeOnly, setRouteOnly] = useState(false);
  const [minKm, setMinKm] = useState('');
  const [pendingDelete, setPendingDelete] = useState<WorkoutSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [timeZone, setTimeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const navigate = useNavigate();

  const load = () =>
    api
      .workouts()
      .then((r) => setWorkouts([...r.workouts].sort((a, b) => b.startUtc - a.startUtc)))
      .catch(() => setError(true));

  useEffect(() => {
    load();
    api
      .settings()
      .then((r) => setTimeZone(r.settings.timeZone))
      .catch(() => {});
  }, []);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteWorkout(pendingDelete.id);
      setPendingDelete(null);
      await load();
    } catch {
      setError(true);
    } finally {
      setDeleting(false);
    }
  };

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
          <div
            className="table-scroll ride-library-scroll"
            role="region"
            aria-label="Ride library table"
            tabIndex={0}
          >
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
                  <th aria-label="Actions" />
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
                    <td>{fmtDate(w.startUtc, timeZone)}</td>
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
                    <td>
                      <button
                        className="btn"
                        style={{ padding: '4px 10px', fontSize: 12 }}
                        aria-label={`Delete ride from ${fmtDate(w.startUtc, timeZone)}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDelete(w);
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this ride?"
          danger
          busy={deleting}
          confirmLabel="Delete ride"
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
          body={
            <>
              <p style={{ margin: 0 }}>
                This permanently removes the ride from {fmtDate(pendingDelete.startUtc, timeZone)} —
                metric samples, route, and analytics — from your local database.
              </p>
              <p style={{ margin: '8px 0 0', fontWeight: 600 }}>
                This is irreversible unless you have a backup.
              </p>
            </>
          }
        />
      )}
    </div>
  );
}
