import { useEffect, useState } from 'react';
import { api, type Settings } from '../api.ts';
import { ConfirmDialog } from '../components/ui.tsx';
import { validateZoneBoundsDraft } from '../settings-form.ts';

/** Settings: HR zones (user-authoritative, never inferred) + thresholds. */
export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [bounds, setBounds] = useState<string[]>(['', '', '', '', '']);
  const [timeZone, setTimeZone] = useState('');
  const [saved, setSaved] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [zoneError, setZoneError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
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
      .catch(() => setLoadFailed(true));
  }, []);

  const save = async () => {
    setSaved(false);
    const zoneDraft = validateZoneBoundsDraft(bounds);
    if (zoneDraft.error) {
      setZoneError(zoneDraft.error);
      setSaveError(null);
      return;
    }
    if (!timeZone.trim()) {
      setSaveError('Enter a valid IANA timezone.');
      return;
    }
    try {
      const r = await api.saveSettings({
        hrZoneBounds: zoneDraft.value,
        timeZone: timeZone.trim(),
      });
      setSettings(r.settings);
      setTimeZone(r.settings.timeZone);
      setBounds(r.settings.hrZoneBounds?.map(String) ?? ['', '', '', '', '']);
      setZoneError(null);
      setSaveError(null);
      setSaved(true);
    } catch {
      setSaveError('Settings were not saved. Check the timezone and zone boundaries.');
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

  if (loadFailed) return <p className="muted">The local API is not reachable.</p>;
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
            onChange={(e) => {
              setTimeZone(e.target.value);
              setSaved(false);
              setSaveError(null);
            }}
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
                aria-invalid={zoneError !== null}
                aria-describedby="zone-bounds-status"
                style={{ width: 76 }}
                onChange={(e) => {
                  const next = bounds.map((previous, index) =>
                    index === i ? e.target.value : previous,
                  );
                  setBounds(next);
                  setSaved(false);
                  setZoneError(validateZoneBoundsDraft(next).error);
                  setSaveError(null);
                }}
              />
            </label>
          ))}
        </div>
        <p
          id="zone-bounds-status"
          className="muted"
          role="status"
          aria-live="polite"
          style={{ fontSize: 12, margin: '8px 0 0', minHeight: '1.2em' }}
        >
          {zoneError ?? ''}
        </p>
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
      <p
        className="muted"
        role="status"
        aria-live="polite"
        style={{ margin: 0, minHeight: '1.2em' }}
      >
        {saveError ?? ''}
      </p>

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
