import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type WorkoutDetail, type WorkoutSummary } from '../api.ts';
import { fmtDate, fmtDuration, fmtInt, fmtKm, fmtSpeedKmh, type Pt } from '../chartspec/spec.ts';
import { TimeSeriesChart } from '../components/charts.tsx';
import { InteractiveRouteMap } from '../components/interactive-route-map.tsx';
import { ElevationProfile, ZoneStrip } from '../components/route.tsx';
import { ConfirmDialog, Kpi, EmptyState } from '../components/ui.tsx';
import { findPreviousWorkout, repairAndReloadRide } from '../ride-repair.ts';

const CH = {
  hr: 'var(--vg-ch-hr)',
  speed: 'var(--vg-ch-speed)',
  cadence: 'var(--vg-ch-cadence)',
  elevation: 'var(--vg-ch-elevation)',
  power: 'var(--vg-ch-power)',
};

/** Ride detail (RIDE-003/004/006, ROUTE-002/003): synchronized charts + route. */
export function RideDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<WorkoutDetail | null>(null);
  const [error, setError] = useState(false);
  const [cursorT, setCursorT] = useState<number | null>(null);
  const [previous, setPrevious] = useState<WorkoutSummary | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairMessage, setRepairMessage] = useState<string | null>(null);
  const [timeZone, setTimeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );

  useEffect(() => {
    if (!id) return;
    api
      .workout(Number(id))
      .then(setDetail)
      .catch(() => setError(true));
    api
      .workouts()
      .then((r) => {
        setPrevious(findPreviousWorkout(r.workouts, Number(id)));
      })
      .catch(() => {});
    api
      .settings()
      .then((r) => setTimeZone(r.settings.timeZone))
      .catch(() => {});
  }, [id]);

  const deleteRide = async () => {
    if (!id) return;
    setDeleting(true);
    try {
      await api.deleteWorkout(Number(id));
      navigate('/');
    } catch {
      setError(true);
    } finally {
      setDeleting(false);
    }
  };

  const repairRide = async () => {
    if (!id) return;
    setRepairing(true);
    setRepairMessage(null);
    try {
      const refreshed = await repairAndReloadRide(api, Number(id));
      setDetail(refreshed.detail);
      setPrevious(refreshed.previous);
      setCursorT(null);
      setRepairMessage('Repaired: canonical ride details and analytics were reloaded.');
    } catch {
      setRepairMessage('Repair or canonical reload failed — the local API may be unreachable.');
    } finally {
      setRepairing(false);
    }
  };

  const series = useMemo(() => {
    if (!detail) return null;
    const toPts = (samples?: { t: number; value: number }[]): Pt[] =>
      (samples ?? []).map((s) => ({ t: s.t, v: s.value }));
    // Derived speed series from per-sample distance rate (render-side, from
    // deterministic stored samples): value m per interval → km/h at render.
    const dist = detail.metrics.distance ?? [];
    const speedPts: Pt[] = [];
    for (let i = 1; i < dist.length; i++) {
      const dtS = (dist[i]!.t - dist[i - 1]!.t) / 1000;
      if (dtS > 0 && dtS < 600) speedPts.push({ t: dist[i]!.t, v: (dist[i]!.value / dtS) * 3.6 });
    }
    return {
      hr: toPts(detail.metrics.heart_rate),
      cadence: toPts(detail.metrics.cadence),
      speed: speedPts,
    };
  }, [detail]);

  if (error) return <EmptyState title="Ride not found." />;
  if (!detail || !series) return <p className="muted">Loading…</p>;

  const a = detail.analytics;
  const w = detail.workout;
  const kmSplits = (a?.splits ?? []).filter((s) => s.kind === 'km');

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            Ride · <span className="grad-text">{fmtDate(w.startUtc, timeZone)}</span>
          </h1>
          <div className="page-sub">
            Formula {a?.formulaVersion ?? '–'} · instants stored UTC · displayed {timeZone}
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={repairRide} disabled={repairing}>
            {repairing ? 'Repairing…' : 'Repair ride'}
          </button>
          <button className="btn danger" onClick={() => setConfirmingDelete(true)}>
            Delete ride
          </button>
          <Link to="/" className="btn" style={{ textDecoration: 'none' }}>
            Back to rides
          </Link>
        </div>
      </div>

      {repairMessage && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          {repairMessage}
        </p>
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title="Delete this ride?"
          danger
          busy={deleting}
          confirmLabel="Delete ride"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={deleteRide}
          body={
            <>
              <p style={{ margin: 0 }}>
                This permanently removes this ride from {fmtDate(w.startUtc, timeZone)} — its
                metric samples, route, and analytics — from your local database.
              </p>
              <p style={{ margin: '8px 0 0', fontWeight: 600 }}>
                This is irreversible unless you have a backup.
              </p>
            </>
          }
        />
      )}

      <div className="kpi-grid">
        <Kpi label="Distance" value={fmtKm(a?.distanceM)} unit="km" />
        <Kpi label="Moving time" value={fmtDuration(a?.movingTimeS ?? null)} />
        <Kpi
          label="Elevation gain"
          value={fmtInt(a?.elevation.gainM)}
          unit="m"
          color={CH.elevation}
        />
        <Kpi label="Avg speed" value={fmtSpeedKmh(a?.avgSpeedMs)} unit="km/h" color={CH.speed} />
        <Kpi label="Avg HR" value={fmtInt(a?.heartRate.avg)} unit="bpm" color={CH.hr} />
        <Kpi label="Avg cadence" value={fmtInt(a?.cadence.avg)} unit="rpm" color={CH.cadence} />
        <Kpi label="Energy" value={fmtInt(a?.energyKj)} unit="kJ" color={CH.power} />
      </div>

      <div className="two-col">
        <div className="card">
          <h2 className="card-title">Interactive offline route map</h2>
          <InteractiveRouteMap segments={detail.route} cursorT={cursorT} />
        </div>
        <div className="stack">
          <div className="card">
            <h2 className="card-title">Ride summary</h2>
            <table className="data">
              <tbody>
                {[
                  ['Duration', fmtDuration(a?.durationS ?? null)],
                  ['Moving time', fmtDuration(a?.movingTimeS ?? null)],
                  ['Max speed', `${fmtSpeedKmh(a?.maxSpeedMs)} km/h`],
                  ['Max HR', `${fmtInt(a?.heartRate.max)} bpm`],
                  ['Elevation loss', `${fmtInt(a?.elevation.lossM)} m`],
                  ['Efficiency', a?.efficiency != null ? a.efficiency.toFixed(3) : 'n/a'],
                  [
                    'HR drift (decoupling)',
                    a?.decouplingPct != null ? `${a.decouplingPct.toFixed(1)}%` : 'n/a',
                  ],
                  [
                    'Pacing variability',
                    a?.pacingVariability != null ? a.pacingVariability.toFixed(3) : 'n/a',
                  ],
                ].map(([k, v]) => (
                  <tr key={k}>
                    <td className="muted">{k}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {previous && (
            <div className="card">
              <h2 className="card-title">vs previous ride</h2>
              <table className="data">
                <tbody>
                  <tr>
                    <td className="muted">Distance</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {fmtKm(a?.distanceM)} km{' '}
                      <Delta now={a?.distanceM} prev={previous.distanceM} />
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Avg speed</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {fmtSpeedKmh(a?.avgSpeedMs)} km/h{' '}
                      <Delta now={a?.avgSpeedMs} prev={previous.avgSpeedMs} />
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Avg HR</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {fmtInt(a?.heartRate.avg)} bpm{' '}
                      <Delta now={a?.heartRate.avg} prev={previous.avgHr} invert />
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="muted" style={{ fontSize: 11, margin: '8px 0 0' }}>
                Compared with {fmtDate(previous.startUtc, timeZone)}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="chart-grid">
        <TimeSeriesChart
          title="Heart Rate"
          points={series.hr}
          color={CH.hr}
          unit="bpm"
          format={(v) => String(Math.round(v))}
          tMin={w.startUtc}
          tMax={w.endUtc}
          cursorT={cursorT}
          onCursor={setCursorT}
        />
        <TimeSeriesChart
          title="Speed"
          points={series.speed}
          color={CH.speed}
          unit="km/h"
          format={(v) => v.toFixed(1)}
          tMin={w.startUtc}
          tMax={w.endUtc}
          cursorT={cursorT}
          onCursor={setCursorT}
        />
        <TimeSeriesChart
          title="Cadence"
          points={series.cadence}
          color={CH.cadence}
          unit="rpm"
          format={(v) => String(Math.round(v))}
          tMin={w.startUtc}
          tMax={w.endUtc}
          cursorT={cursorT}
          onCursor={setCursorT}
        />
        <div className="card">
          <div className="chart-tile-head">
            <span className="chart-tile-title">Elevation</span>
            <span className="chart-tile-value" style={{ color: CH.elevation }}>
              {fmtInt(a?.elevation.gainM)}{' '}
              <span className="muted" style={{ fontWeight: 500 }}>
                m gain
              </span>
            </span>
          </div>
          <ElevationProfile
            segments={detail.route}
            cursorT={cursorT}
            tMin={w.startUtc}
            tMax={w.endUtc}
            height={90}
          />
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Performance zones</h2>
        {a?.zones ? (
          <ZoneStrip zones={a.zones.slice(0, 6)} />
        ) : (
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Configure your heart-rate zones in Settings to see time in zone. Velograph never guesses
            zones from age.
          </p>
        )}
      </div>

      {kmSplits.length > 0 && (
        <div className="card">
          <h2 className="card-title">Splits (1 km)</h2>
          <table className="data">
            <thead>
              <tr>
                <th>km</th>
                <th>Time</th>
                <th>Speed</th>
                <th>Avg HR</th>
              </tr>
            </thead>
            <tbody>
              {kmSplits.map((s) => (
                <tr key={s.index}>
                  <td>{s.index}</td>
                  <td>{fmtDuration(s.durationS)}</td>
                  <td>
                    {fmtSpeedKmh(s.avgSpeedMs)} <span className="muted">km/h</span>
                  </td>
                  <td style={{ color: CH.hr }}>
                    {fmtInt(s.avgHr)} <span className="muted">bpm</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {a && Object.keys(a.unavailable).length > 0 && (
        <div className="card">
          <h2 className="card-title">Data limitations</h2>
          <div className="row">
            {Object.entries(a.unavailable).map(([metric, reason]) => (
              <span className="badge warn" key={metric} title={reason}>
                {metric}: {reason.replaceAll('_', ' ')}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Delta({
  now,
  prev,
  invert,
}: {
  now?: number | null | undefined;
  prev?: number | null | undefined;
  invert?: boolean | undefined;
}) {
  if (now == null || prev == null || prev === 0) return null;
  const pct = ((now - prev) / prev) * 100;
  const good = invert ? pct < 0 : pct > 0;
  return (
    <span
      style={{
        color: good ? 'var(--vg-brand-green)' : 'var(--vg-ch-hr)',
        fontSize: 11,
        marginLeft: 6,
      }}
    >
      {pct >= 0 ? '+' : ''}
      {pct.toFixed(1)}%
    </span>
  );
}
