import { useEffect, useState } from 'react';
import { api, type TrendsResponse } from '../api.ts';
import { fmtKm } from '../chartspec/spec.ts';
import { BarChart } from '../components/charts.tsx';
import { EmptyState } from '../components/ui.tsx';

/** Longitudinal dashboard (§9.2, ANA-007 visuals). */
export function Trends() {
  const [data, setData] = useState<TrendsResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api
      .trends()
      .then(setData)
      .catch(() => setError(true));
  }, []);

  if (error) return <EmptyState title="The local API is not reachable." />;
  if (!data) return <p className="muted">Loading…</p>;
  if (data.rides.length === 0) return <EmptyState title="Import rides to see trends." />;

  const weekLabel = (t: number) => new Date(t).toISOString().slice(5, 10);
  const rides = [...data.rides].sort((a, b) => a.startUtc - b.startUtc);
  const rideLabel = (t: number) => new Date(t).toISOString().slice(5, 10);

  // Aggregate zone share across rides that have zones.
  const zoneAgg = new Map<number, { label: string; seconds: number }>();
  for (const r of rides) {
    for (const z of r.zones ?? []) {
      const cur = zoneAgg.get(z.zone) ?? { label: z.label, seconds: 0 };
      cur.seconds += z.seconds;
      zoneAgg.set(z.zone, cur);
    }
  }
  const zoneItems = [...zoneAgg.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([zone, v]) => ({ label: v.label.split(' ')[0] ?? `Z${zone}`, value: v.seconds / 60 }));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Trends</h1>
          <div className="page-sub">
            {rides.length} rides · weekly volume, intensity, and conditioning signals
          </div>
        </div>
        <span className="pill">Deterministic analytics</span>
      </div>

      <div className="chart-grid">
        <div className="card">
          <h2 className="card-title">Weekly distance (km)</h2>
          <BarChart
            items={data.weekly.map((w) => ({
              label: weekLabel(w.weekStartUtc),
              value: w.distanceM / 1000,
            }))}
            color="var(--vg-brand-blue)"
            format={(v) => `${v.toFixed(1)} km`}
          />
        </div>
        <div className="card">
          <h2 className="card-title">Weekly ride count</h2>
          <BarChart
            items={data.weekly.map((w) => ({
              label: weekLabel(w.weekStartUtc),
              value: w.rideCount,
            }))}
            color="var(--vg-brand-green)"
            format={(v) => `${v} rides`}
          />
        </div>
        <div className="card">
          <h2 className="card-title">Avg heart rate by ride (bpm)</h2>
          <BarChart
            items={rides.map((r) => ({ label: rideLabel(r.startUtc), value: r.avgHr ?? 0 }))}
            color="var(--vg-ch-hr)"
            format={(v) => `${Math.round(v)} bpm`}
          />
        </div>
        <div className="card">
          <h2 className="card-title">Avg speed by ride (km/h)</h2>
          <BarChart
            items={rides.map((r) => ({
              label: rideLabel(r.startUtc),
              value: (r.avgSpeedMs ?? 0) * 3.6,
            }))}
            color="var(--vg-ch-speed)"
            format={(v) => `${v.toFixed(1)} km/h`}
          />
        </div>
        <div className="card">
          <h2 className="card-title">Efficiency by ride (km/h per bpm)</h2>
          <BarChart
            items={rides.map((r) => ({ label: rideLabel(r.startUtc), value: r.efficiency ?? 0 }))}
            color="var(--vg-brand-mint)"
            format={(v) => v.toFixed(3)}
          />
        </div>
        <div className="card">
          <h2 className="card-title">Time in zone (minutes)</h2>
          {zoneItems.length > 0 ? (
            <BarChart
              items={zoneItems}
              color="var(--vg-accent-violet)"
              format={(v) => `${v.toFixed(0)} min`}
            />
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Configure heart-rate zones in Settings to see intensity distribution.
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Ride log</h2>
        <table className="data">
          <thead>
            <tr>
              <th>Week</th>
              <th>Rides</th>
              <th>Distance</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {[...data.weekly].reverse().map((w) => (
              <tr key={w.weekStartUtc}>
                <td>{new Date(w.weekStartUtc).toISOString().slice(0, 10)}</td>
                <td>{w.rideCount}</td>
                <td>
                  {fmtKm(w.distanceM)} <span className="muted">km</span>
                </td>
                <td>
                  {(w.durationS / 3600).toFixed(1)} <span className="muted">h</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
