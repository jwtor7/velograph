import { useEffect, useState } from 'react';
import { api, type Settings } from '../api.ts';

/** Settings: HR zones (user-authoritative, never inferred) + thresholds. */
export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [bounds, setBounds] = useState<string[]>(['', '', '', '', '']);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    api
      .settings()
      .then((r) => {
        setSettings(r.settings);
        if (r.settings.hrZoneBounds) {
          setBounds(r.settings.hrZoneBounds.map(String));
        }
      })
      .catch(() => setError(true));
  }, []);

  const save = async () => {
    setSaved(false);
    const nums = bounds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const ascending = nums.length === 5 && nums.every((n, i) => i === 0 || n > nums[i - 1]!);
    try {
      const r = await api.saveSettings({
        hrZoneBounds: ascending ? nums : null,
      });
      setSettings(r.settings);
      setSaved(true);
    } catch {
      setError(true);
    }
  };

  if (error) return <p className="muted">The local API is not reachable.</p>;
  if (!settings) return <p className="muted">Loading…</p>;

  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <div className="page-sub">Stored locally in your Velograph data directory</div>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Heart-rate zones (bpm boundaries)</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Enter the five ascending boundaries between your six zones. Your values are authoritative
          — Velograph never infers zones from age. Leave blank to disable zone analysis.
        </p>
        <div className="row">
          {bounds.map((b, i) => (
            <label key={i}>
              <span className="field-label">
                Z{i + 1}/Z{i + 2}
              </span>
              <input
                type="number"
                value={b}
                min="40"
                max="230"
                style={{ width: 76 }}
                onChange={(e) =>
                  setBounds((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))
                }
              />
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Calculation thresholds</h2>
        <table className="data">
          <tbody>
            <tr>
              <td className="muted">Moving-speed threshold</td>
              <td style={{ textAlign: 'right' }}>{settings.movingSpeedThresholdMs} m/s</td>
            </tr>
            <tr>
              <td className="muted">Efficiency coverage minimum</td>
              <td style={{ textAlign: 'right' }}>{settings.minCoverageForEfficiency}</td>
            </tr>
            <tr>
              <td className="muted">Elevation noise filter</td>
              <td style={{ textAlign: 'right' }}>{settings.elevationHysteresisM} m</td>
            </tr>
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 11, margin: '8px 0 0' }}>
          Documented in docs/formulas.md. Changing thresholds recalculates analytics on next view.
        </p>
      </div>

      <div className="row">
        <button className="btn primary" onClick={save}>
          Save settings
        </button>
        {saved && <span style={{ color: 'var(--vg-brand-green)', fontSize: 12 }}>Saved</span>}
      </div>
    </div>
  );
}
