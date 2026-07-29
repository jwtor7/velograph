import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ImportResultBody } from '../api.ts';

interface Picked {
  name: string;
  size: number;
  file: File;
}

const ACCEPT = '.csv,.gpx,.zip';

/** Import screen (IMP-001, journey 7.2): inventory, confirm, value-free result. */
export function ImportPage() {
  const [picked, setPicked] = useState<Picked[]>([]);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResultBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | File[]) => {
    const list = [...files].filter((f) => /\.(csv|gpx|zip)$/i.test(f.name));
    setPicked((prev) => {
      const seen = new Set(prev.map((p) => p.name + p.size));
      const merged = [...prev];
      for (const f of list) {
        if (!seen.has(f.name + f.size)) merged.push({ name: f.name, size: f.size, file: f });
      }
      return merged;
    });
    setResult(null);
    setError(null);
  };

  const runImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const files = await Promise.all(
        picked.map(async (p) => ({
          name: p.name,
          dataBase64: await toBase64(p.file),
        })),
      );
      const res = await api.importFiles(files);
      setResult(res.result);
      setPicked([]);
    } catch {
      setError('Import failed. Check that the local API is running, then try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Import from Apple Health</h1>
          <div className="page-sub">
            Health Auto Export folder, CSV, GPX, or ZIP · files are read locally and never leave
            this machine
          </div>
        </div>
        <span className="pill">Local-first · Offline</span>
      </div>

      <div
        className={`dropzone ${drag ? 'drag' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <p style={{ margin: 0, fontSize: 15 }}>
          Drop your export files here, or{' '}
          <span className="grad-text" style={{ fontWeight: 600 }}>
            browse
          </span>
        </p>
        <p className="muted" style={{ margin: '6px 0 12px', fontSize: 12 }}>
          One CSV contains one metric. Choose the export folder or all companion files for a
          complete ride.
        </p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <button
            type="button"
            className="btn"
            onClick={(e) => {
              e.stopPropagation();
              inputRef.current?.click();
            }}
          >
            Choose files
          </button>
          <button
            type="button"
            className="btn"
            onClick={(e) => {
              e.stopPropagation();
              folderInputRef.current?.click();
            }}
          >
            Choose export folder
          </button>
        </div>
        <p style={{ margin: '10px 0 0', fontSize: 11 }}>.csv · .gpx · .zip</p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
        <input
          ref={(node) => {
            folderInputRef.current = node;
            node?.setAttribute('webkitdirectory', '');
          }}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
      </div>

      {picked.length > 0 && (
        <div className="card">
          <h2 className="card-title">Ready to import ({picked.length} files)</h2>
          <table className="data">
            <tbody>
              {picked.map((p) => (
                <tr key={p.name + p.size}>
                  <td>{p.name}</td>
                  <td className="muted" style={{ textAlign: 'right' }}>
                    {(p.size / 1024).toFixed(1)} KB
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={runImport} disabled={busy}>
              {busy ? 'Importing…' : 'Confirm import'}
            </button>
            <button className="btn" onClick={() => setPicked([])} disabled={busy}>
              Clear
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: 'rgba(237,73,51,0.5)' }}>
          <p style={{ margin: 0, color: 'var(--vg-ch-hr)' }}>{error}</p>
        </div>
      )}

      {result && (
        <div className="card">
          <h2 className="card-title">Import complete</h2>
          <div className="kpi-grid">
            <div className="kpi">
              <div className="kpi-label">Files imported</div>
              <div className="kpi-value">{result.imported}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Duplicates skipped</div>
              <div className="kpi-value">{result.skippedDuplicates}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Quarantined</div>
              <div className="kpi-value">{result.quarantined}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">New workouts</div>
              <div className="kpi-value" style={{ color: 'var(--vg-brand-green)' }}>
                {result.workoutsCreated}
              </div>
            </div>
          </div>
          {result.quarantinedFiles.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h3 className="card-title">Quarantined files</h3>
              {result.quarantinedFiles.map((q) => (
                <p key={q.name} style={{ margin: '4px 0', fontSize: 12 }}>
                  <span className="badge warn">{q.code.replaceAll('_', ' ')}</span>{' '}
                  <span className="muted">{q.name}</span>
                </p>
              ))}
            </div>
          )}
          <div style={{ marginTop: 14 }}>
            <Link to="/" className="btn" style={{ textDecoration: 'none' }}>
              View rides
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
