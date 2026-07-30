import { useEffect, useMemo, useState } from 'react';
import { api, type WorkoutDetail, type WorkoutSummary } from '../api.ts';
import { fmtDate, fmtDuration, fmtInt, type Pt } from '../chartspec/spec.ts';
import { TimeSeriesChart } from '../components/charts.tsx';
import { InteractiveRouteMap } from '../components/interactive-route-map.tsx';
import { ElevationProfile, ZoneStrip } from '../components/route.tsx';
import { ConfirmDialog, Kpi, EmptyState } from '../components/ui.tsx';
import { formatDistance, formatElevation, formatSpeed, speedChartValue } from '../display-units.ts';
import {
  priorWorkouts,
  selectRideComparison,
  type RideComparisonChoice,
} from '../ride-comparison.ts';
import {
  DEFAULT_ROUTE_REDACTION_RADIUS_M,
  downloadRideExport,
  MAX_ROUTE_REDACTION_RADIUS_M,
  MIN_ROUTE_REDACTION_RADIUS_M,
} from '../ride-export.ts';
import { repairAndReloadRide } from '../ride-repair.ts';
import { Link, useNavigate, useParams } from '../router.tsx';

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
  const [workouts, setWorkouts] = useState<WorkoutSummary[]>([]);
  const [comparisonChoice, setComparisonChoice] = useState<RideComparisonChoice>('previous');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingExport, setConfirmingExport] = useState(false);
  const [redactRouteEndpoints, setRedactRouteEndpoints] = useState(true);
  const [routeRedactionRadiusM, setRouteRedactionRadiusM] = useState(
    DEFAULT_ROUTE_REDACTION_RADIUS_M,
  );
  const [deleting, setDeleting] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairMessage, setRepairMessage] = useState<string | null>(null);
  const [timeZone, setTimeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [displayUnits, setDisplayUnits] = useState<'metric' | 'imperial'>('metric');

  useEffect(() => {
    if (!id) return;
    api
      .workout(Number(id))
      .then(setDetail)
      .catch(() => setError(true));
    api
      .settings()
      .then((r) => {
        setTimeZone(r.settings.timeZone);
        setDisplayUnits(r.settings.displayUnits);
      })
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    if (!id || detail?.workout.id !== Number(id)) return;
    // Render the selected ride, charts, and map before requesting comparison
    // summaries. On a fresh import that list may compute analytics for many
    // rides; it must not block the primary ride-open experience.
    const timer = window.setTimeout(() => {
      api
        .workouts()
        .then((r) => setWorkouts(r.workouts))
        .catch(() => {});
    }, 0);
    return () => window.clearTimeout(timer);
  }, [detail, id]);

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
      setWorkouts(refreshed.workouts);
      setCursorT(null);
      setRepairMessage('Repaired: canonical ride details and analytics were reloaded.');
    } catch {
      setRepairMessage('Repair or canonical reload failed — the local API may be unreachable.');
    } finally {
      setRepairing(false);
    }
  };

  const exportRide = () => {
    if (!detail) return;
    downloadRideExport(detail, {
      redactRouteEndpoints,
      routeRedactionRadiusM,
    });
    setConfirmingExport(false);
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
      if (dtS > 0 && dtS < 600) {
        speedPts.push({
          t: dist[i]!.t,
          v: speedChartValue(dist[i]!.value / dtS, displayUnits),
        });
      }
    }
    return {
      hr: toPts(detail.metrics.heart_rate),
      cadence: toPts(detail.metrics.cadence),
      speed: speedPts,
    };
  }, [detail, displayUnits]);

  const comparison = useMemo(
    () => selectRideComparison(workouts, Number(id), comparisonChoice),
    [comparisonChoice, id, workouts],
  );
  const comparisonRideOptions = useMemo(
    () =>
      workouts
        .filter((workout) => workout.id !== Number(id))
        .sort((left, right) => right.startUtc - left.startUtc || right.id - left.id),
    [id, workouts],
  );
  const hasPreviousRide = useMemo(
    () => priorWorkouts(workouts, Number(id)).length > 0,
    [id, workouts],
  );

  if (error) return <EmptyState title="Ride not found." />;
  if (!detail || !series) return <p className="muted">Loading…</p>;

  const a = detail.analytics;
  const w = detail.workout;
  const distanceSplits = (a?.splits ?? []).filter((s) => s.kind === 'km');
  const rideDistance = formatDistance(a?.distanceM, displayUnits);
  const averageSpeed = formatSpeed(a?.avgSpeedMs, displayUnits);
  const maximumSpeed = formatSpeed(a?.maxSpeedMs, displayUnits);
  const elevationGain = formatElevation(a?.elevation.gainM, displayUnits);
  const elevationLoss = formatElevation(a?.elevation.lossM, displayUnits);

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
          <button className="btn" onClick={() => setConfirmingExport(true)}>
            Export ride
          </button>
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
                This permanently removes this ride from {fmtDate(w.startUtc, timeZone)} — its metric
                samples, route, and analytics — from your local database.
              </p>
              <p style={{ margin: '8px 0 0', fontWeight: 600 }}>
                This is irreversible unless you have a backup.
              </p>
            </>
          }
        />
      )}

      {confirmingExport && (
        <ConfirmDialog
          title="Export this ride?"
          confirmLabel="Download JSON"
          onCancel={() => setConfirmingExport(false)}
          onConfirm={exportRide}
          body={
            <div className="stack" style={{ gap: 10 }}>
              <p style={{ margin: 0 }}>
                The export contains canonical ride samples, analytics, and route coordinates. Source
                and device metadata are excluded.
              </p>
              <label className="row" style={{ alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={redactRouteEndpoints}
                  onChange={(event) => setRedactRouteEndpoints(event.target.checked)}
                />
                Redact route start and finish
              </label>
              <label>
                <span className="muted">Redaction radius (metres)</span>
                <input
                  aria-label="Route redaction radius in metres"
                  type="number"
                  min={MIN_ROUTE_REDACTION_RADIUS_M}
                  max={MAX_ROUTE_REDACTION_RADIUS_M}
                  step={50}
                  value={routeRedactionRadiusM}
                  disabled={!redactRouteEndpoints}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) {
                      setRouteRedactionRadiusM(
                        Math.min(
                          MAX_ROUTE_REDACTION_RADIUS_M,
                          Math.max(MIN_ROUTE_REDACTION_RADIUS_M, value),
                        ),
                      );
                    }
                  }}
                  style={{ display: 'block', width: '100%', marginTop: 4 }}
                />
              </label>
              {!redactRouteEndpoints && (
                <p className="badge warn" style={{ margin: 0 }}>
                  Exact route endpoints will be included. They may reveal a home or another private
                  location.
                </p>
              )}
            </div>
          }
        />
      )}

      <div className="kpi-grid">
        <Kpi label="Distance" value={rideDistance.value} unit={rideDistance.unit} />
        <Kpi label="Moving time" value={fmtDuration(a?.movingTimeS ?? null)} />
        <Kpi
          label="Elevation gain"
          value={elevationGain.value}
          unit={elevationGain.unit}
          color={CH.elevation}
        />
        <Kpi
          label="Avg speed"
          value={averageSpeed.value}
          unit={averageSpeed.unit}
          color={CH.speed}
        />
        <Kpi label="Avg HR" value={fmtInt(a?.heartRate.avg)} unit="bpm" color={CH.hr} />
        <Kpi label="Avg cadence" value={fmtInt(a?.cadence.avg)} unit="rpm" color={CH.cadence} />
        <Kpi label="Energy" value={fmtInt(a?.energyKj)} unit="kJ" color={CH.power} />
      </div>

      <div className="two-col">
        <div className="card">
          <h2 className="card-title">Interactive offline route map</h2>
          <InteractiveRouteMap
            segments={detail.route}
            cursorT={cursorT}
            displayUnits={displayUnits}
          />
        </div>
        <div className="stack">
          <div className="card">
            <h2 className="card-title">Ride summary</h2>
            <table className="data">
              <tbody>
                {[
                  ['Duration', fmtDuration(a?.durationS ?? null)],
                  ['Moving time', fmtDuration(a?.movingTimeS ?? null)],
                  ['Max speed', `${maximumSpeed.value} ${maximumSpeed.unit}`],
                  ['Max HR', `${fmtInt(a?.heartRate.max)} bpm`],
                  ['Elevation loss', `${elevationLoss.value} ${elevationLoss.unit}`],
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
          {comparisonRideOptions.length > 0 && (
            <div className="card">
              <h2 className="card-title">Ride comparison</h2>
              <label>
                <span className="field-label">Compare with</span>
                <select
                  aria-label="Compare ride with"
                  value={comparisonChoice}
                  onChange={(event) =>
                    setComparisonChoice(event.target.value as RideComparisonChoice)
                  }
                  style={{ width: '100%', marginBottom: 8 }}
                >
                  <option value="previous" disabled={!hasPreviousRide}>
                    Previous ride
                  </option>
                  <option value="recent_median" disabled={!hasPreviousRide}>
                    Recent median (up to 5 prior rides)
                  </option>
                  {comparisonRideOptions.map((ride) => (
                    <option key={ride.id} value={`ride:${ride.id}`}>
                      Ride on {fmtDate(ride.startUtc, timeZone)}
                    </option>
                  ))}
                </select>
              </label>
              {comparison ? (
                <>
                  <table className="data">
                    <tbody>
                      <tr>
                        <td className="muted">Distance</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>
                          {rideDistance.value} {rideDistance.unit}{' '}
                          <Delta now={a?.distanceM} prev={comparison.distanceM} />
                        </td>
                      </tr>
                      <tr>
                        <td className="muted">Avg speed</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>
                          {averageSpeed.value} {averageSpeed.unit}{' '}
                          <Delta now={a?.avgSpeedMs} prev={comparison.avgSpeedMs} />
                        </td>
                      </tr>
                      <tr>
                        <td className="muted">Avg HR</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>
                          {fmtInt(a?.heartRate.avg)} bpm{' '}
                          <Delta now={a?.heartRate.avg} prev={comparison.avgHr} invert />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <p className="muted" style={{ fontSize: 11, margin: '8px 0 0' }}>
                    {comparison.kind === 'ride' && comparison.ride
                      ? `Compared with ${fmtDate(comparison.ride.startUtc, timeZone)}`
                      : `Recent window of ${comparison.windowSize} prior rides · median coverage distance ${comparison.sampleSizes.distanceM}/${comparison.windowSize}, speed ${comparison.sampleSizes.avgSpeedMs}/${comparison.windowSize}, HR ${comparison.sampleSizes.avgHr}/${comparison.windowSize}`}{' '}
                    · source data quality {comparison.qualityStates.join(', ').replaceAll('_', ' ')}
                    {' · '}formula {a?.formulaVersion ?? 'unavailable'}
                  </p>
                </>
              ) : (
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  No prior ride is available. Choose a specific ride above.
                </p>
              )}
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
          unit={displayUnits === 'imperial' ? 'mph' : 'km/h'}
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
              {elevationGain.value}{' '}
              <span className="muted" style={{ fontWeight: 500 }}>
                {elevationGain.unit} gain
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

      {distanceSplits.length > 0 && (
        <div className="card">
          <h2 className="card-title">Distance splits</h2>
          <p className="muted" style={{ marginTop: 0, fontSize: 11 }}>
            Analytics use canonical 1,000 m intervals; distances follow your display units.
          </p>
          <table className="data">
            <thead>
              <tr>
                <th>Split</th>
                <th>Distance</th>
                <th>Time</th>
                <th>Speed</th>
                <th>Avg HR</th>
              </tr>
            </thead>
            <tbody>
              {distanceSplits.map((s) => {
                const distance = formatDistance(s.distanceM, displayUnits);
                const speed = formatSpeed(s.avgSpeedMs, displayUnits);
                return (
                  <tr key={s.index}>
                    <td>{s.index}</td>
                    <td>
                      {distance.value} <span className="muted">{distance.unit}</span>
                    </td>
                    <td>{fmtDuration(s.durationS)}</td>
                    <td>
                      {speed.value} <span className="muted">{speed.unit}</span>
                    </td>
                    <td style={{ color: CH.hr }}>
                      {fmtInt(s.avgHr)} <span className="muted">bpm</span>
                    </td>
                  </tr>
                );
              })}
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
