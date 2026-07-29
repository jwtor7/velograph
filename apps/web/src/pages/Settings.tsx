import { useEffect, useState } from 'react';
import { api, type Settings } from '../api.ts';
import { ConfirmDialog } from '../components/ui.tsx';

/** Settings: HR zones (user-authoritative, never inferred) + thresholds. */
export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [bounds, setBounds] = useState<string[]>(['', '', '', '', '']);
  const [timeZone, setTimeZone] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(false);
  const [backupPath, setBackupPath] = useState('');
  const [restorePath, setRestorePath] = useState('');
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [restoreStatus, setRestoreStatus] = useState<string | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirmingRestore, setConfirmingRestore] = useState(false);

  useEffect(() => {
    api
      .settings()
      .then((r) => {
        setSettings(r.settings);
        setTimeZone(r.settings.timeZone);
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
        timeZone,
      });
      setSettings(r.settings);
      setSaved(true);
    } catch {
      setError(true);
    }
  };

  const runBackup = async () => {
    if (!backupPath.trim()) return;
    setBackingUp(true);
    setBackupStatus(null);
    try {
      const result = await api.backup(backupPath.trim());
      setBackupStatus(
        `Backup written · format ${result.manifest.formatVersion} · ${result.manifest.schemaVersion}`,
      );
    } catch {
      setBackupStatus(
        'Backup failed — check the path is writable and outside the Velograph checkout.',
      );
    } finally {
      setBackingUp(false);
    }
  };

  const runRestore = async () => {
    if (!restorePath.trim()) return;
    setRestoring(true);
    setRestoreStatus(null);
    setConfirmingRestore(false);
    try {
      const result = await api.restore(restorePath.trim());
      setRestoreStatus(
        result.report.legacyBackup
          ? `Restored and upgraded a legacy backup · integrity verified · ${result.report.schemaVersion}`
          : `Restored · manifest, checksums, database, and foreign keys verified · ${result.report.schemaVersion}`,
      );
    } catch {
      setRestoreStatus('Restore failed — check the path points to a Velograph backup file.');
    } finally {
      setRestoring(false);
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
        <h2 className="card-title">Import and display timezone</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Health Auto Export metric CSVs can omit their UTC offset. Velograph uses this IANA
          timezone to align those wall times with absolute GPX timestamps and to display local ride
          dates.
        </p>
        <label>
          <span className="field-label">IANA timezone</span>
          <input
            type="text"
            value={timeZone}
            spellCheck={false}
            placeholder="America/Toronto"
            style={{ width: 240 }}
            onChange={(e) => setTimeZone(e.target.value)}
          />
        </label>
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

      <div className="card">
        <h2 className="card-title">Data management</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Export the full local database with SQLite's own backup mechanism, or restore it from a
          previous export. Both run on this machine — the path is a location on this computer, never
          uploaded anywhere. Backups contain an app/schema manifest and deterministic checksums, and
          must be written outside the Velograph source checkout.
        </p>

        <div className="stack">
          <div>
            <span className="field-label">Back up to path</span>
            <div className="row">
              <input
                type="text"
                placeholder="/path/to/velograph-backup.sqlite3"
                value={backupPath}
                onChange={(e) => setBackupPath(e.target.value)}
                style={{ flex: 1, minWidth: 260 }}
              />
              <button
                className="btn"
                onClick={runBackup}
                disabled={backingUp || !backupPath.trim()}
              >
                {backingUp ? 'Backing up…' : 'Back up now'}
              </button>
            </div>
            {backupStatus && (
              <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
                {backupStatus}
              </p>
            )}
          </div>

          <div>
            <span className="field-label">Restore from path</span>
            <div className="row">
              <input
                type="text"
                placeholder="/path/to/velograph-backup.sqlite3"
                value={restorePath}
                onChange={(e) => setRestorePath(e.target.value)}
                style={{ flex: 1, minWidth: 260 }}
              />
              <button
                className="btn danger"
                onClick={() => setConfirmingRestore(true)}
                disabled={restoring || !restorePath.trim()}
              >
                {restoring ? 'Restoring…' : 'Restore'}
              </button>
            </div>
            {restoreStatus && (
              <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
                {restoreStatus}
              </p>
            )}
          </div>
        </div>
      </div>

      {confirmingRestore && (
        <ConfirmDialog
          title="Restore from backup?"
          danger
          busy={restoring}
          confirmLabel="Restore"
          onCancel={() => setConfirmingRestore(false)}
          onConfirm={runRestore}
          body={
            <>
              <p style={{ margin: 0 }}>
                This replaces everything currently in your Velograph database with the contents of
                the backup file. Velograph verifies its manifest, checksums, SQLite integrity,
                foreign keys, and compatible migration history before replacement.
              </p>
              <p style={{ margin: '8px 0 0', fontWeight: 600 }}>
                Anything imported or changed since that backup was taken will be lost.
              </p>
            </>
          }
        />
      )}
    </div>
  );
}
