import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  api,
  type FolderPreviewBody,
  type FolderSkipItem,
  type ImportResultBody,
} from '../api.ts';
import { requestCurrentFolderPreview } from './import-preview.ts';

interface Picked {
  name: string;
  size: number;
  file: File;
}

const ACCEPT = '.csv,.gpx,.zip';
const STALE_FOLDER_PREVIEW_CODES = new Set([
  'path_changed',
  'file_changed',
  'path_not_found',
  'not_a_directory',
]);

/**
 * Recursively read every file entry under a dropped `FileSystemEntry`
 * (issue #51: folder drag-and-drop via `webkitGetAsEntry`). Browsers do not
 * expose the OS-absolute path of a dropped folder — that's a platform
 * limitation, not something this app can work around — so a dropped folder
 * is read into the existing multi-file list rather than the path field.
 * Large exports are better served by pasting the path below, which reads
 * from disk instead of buffering every file into the page.
 */
function readEntryFiles(entry: FileSystemEntry): Promise<File[]> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      (entry as FileSystemFileEntry).file(
        (file) => resolve([file]),
        () => resolve([]),
      );
      return;
    }
    if (!entry.isDirectory) {
      resolve([]);
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const collected: File[] = [];
    const readBatch = () => {
      reader.readEntries(
        (entries) => {
          if (entries.length === 0) {
            resolve(collected);
            return;
          }
          Promise.all(entries.map(readEntryFiles))
            .then((groups) => {
              for (const g of groups) collected.push(...g);
              readBatch(); // a directory reader may require several calls to exhaust all entries
            })
            .catch(() => resolve(collected));
        },
        () => resolve(collected),
      );
    };
    readBatch();
  });
}

/** Import screen (IMP-001, journey 7.2): inventory, confirm, value-free result. */
export function ImportPage() {
  const [picked, setPicked] = useState<Picked[]>([]);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResultBody | null>(null);
  const [resultSkipped, setResultSkipped] = useState<FolderSkipItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [folderPath, setFolderPath] = useState('');
  const folderPathRef = useRef('');
  const [preview, setPreview] = useState<FolderPreviewBody | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pathBusy, setPathBusy] = useState(false);

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

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDrag(false);
    const items = e.dataTransfer.items;
    const entries =
      items && items.length > 0
        ? [...items].map((it) => it.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x)
        : [];
    if (entries.length > 0 && entries.some((en) => en.isDirectory)) {
      const groups = await Promise.all(entries.map(readEntryFiles));
      addFiles(groups.flat());
      return;
    }
    addFiles(e.dataTransfer.files);
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
      setResultSkipped([]);
      setPicked([]);
    } catch {
      setError('Import failed. Check that the local API is running, then try again.');
    } finally {
      setBusy(false);
    }
  };

  const loadPreview = async () => {
    const requestedPath = folderPath.trim();
    setPreviewBusy(true);
    setPreviewError(null);
    setResult(null);
    try {
      const res = await requestCurrentFolderPreview(
        requestedPath,
        () => folderPathRef.current,
        api.importPathPreview,
      );
      if (res.status === 'stale') return;
      setPreview(res.preview);
      if (res.preview.truncated) {
        setPreviewError(
          'This folder exceeded the safe traversal or import limits. Narrow the folder and preview again.',
        );
      } else if (res.preview.rides.length === 0 && res.preview.ungrouped.length === 0) {
        setPreviewError('No importable .csv/.gpx/.zip files were found in that folder.');
      }
    } catch {
      setPreview(null);
      setPreviewError(
        'Could not read that folder. Check the path, that it exists, and that it is outside ' +
          'the Velograph source checkout.',
      );
    } finally {
      setPreviewBusy(false);
    }
  };

  const confirmPathImport = async () => {
    setPathBusy(true);
    setPreviewError(null);
    try {
      if (!preview || preview.truncated) {
        setPreviewError(
          'This folder exceeded the safe traversal or import limits. Narrow the folder and preview again.',
        );
        return;
      }
      const res = await api.importPath(folderPath.trim(), preview.confirmationToken);
      setResult(res.result);
      setResultSkipped(res.skipped);
      setPreview(null);
      folderPathRef.current = '';
      setFolderPath('');
    } catch (err) {
      if (err instanceof ApiError && STALE_FOLDER_PREVIEW_CODES.has(err.code)) {
        setPreview(null);
        setPreviewError('The folder changed after preview. Preview it again before importing.');
      } else if (err instanceof ApiError && err.code === 'folder_limits_exceeded') {
        setPreviewError(
          'This folder exceeded the safe traversal or import limits. Narrow the folder and preview again.',
        );
      } else {
        setPreviewError('Import failed. Check that the local API is running, then try again.');
      }
    } finally {
      setPathBusy(false);
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
        onDrop={(e) => void handleDrop(e)}
      >
        <p style={{ margin: 0, fontSize: 15 }}>
          Drop your export files or folder here, or{' '}
          <span className="grad-text" style={{ fontWeight: 600 }}>
            browse
          </span>
        </p>
        <p className="muted" style={{ margin: '6px 0 12px', fontSize: 12 }}>
          One CSV contains one metric. Drop the whole export folder or every companion file for a
          complete ride — or paste the folder path below for a large export.
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

      <div className="card">
        <h2 className="card-title">Import from a folder path</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Paste the full path to your Health Auto Export folder. The API reads it directly from disk
          — nothing is uploaded as base64 — so this is the reliable way to bring in a large export
          with dozens of files across many rides. Preview groups files by ride before anything is
          imported.
        </p>
        <span className="field-label">Folder path</span>
        <div className="row">
          <input
            type="text"
            placeholder="/path/to/Health Auto Export"
            value={folderPath}
            onChange={(e) => {
              folderPathRef.current = e.target.value;
              setFolderPath(e.target.value);
              setPreview(null);
              setPreviewError(null);
            }}
            style={{ flex: 1, minWidth: 260 }}
          />
          <button
            className="btn"
            onClick={loadPreview}
            disabled={previewBusy || pathBusy || !folderPath.trim()}
          >
            {previewBusy ? 'Scanning…' : 'Preview folder'}
          </button>
        </div>
        {previewError && (
          <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--vg-ch-hr)' }}>
            {previewError}
          </p>
        )}

        {preview && (
          <div style={{ marginTop: 14 }}>
            <p className="muted" style={{ fontSize: 12 }}>
              {preview.totalFiles} file{preview.totalFiles === 1 ? '' : 's'} ·{' '}
              {(preview.totalBytes / (1024 * 1024)).toFixed(1)} MB
              {preview.truncated ? ' · limit exceeded — import is disabled' : ''}
            </p>

            {preview.rides.map((r) => (
              <div key={r.rideKey} style={{ margin: '8px 0' }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {r.workoutType === 'indoor_cycling' ? 'Indoor' : 'Outdoor'} ride · {r.stampHint}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    {' '}
                    · {r.files.length} file{r.files.length === 1 ? '' : 's'}
                  </span>
                </div>
                <ul className="muted" style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>
                  {r.files.map((f) => (
                    <li key={f.relativePath}>
                      {f.label} ({f.format})
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {preview.ungrouped.length > 0 && (
              <div style={{ margin: '8px 0' }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  Not part of a recognized ride ({preview.ungrouped.length})
                </div>
                <ul className="muted" style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>
                  {preview.ungrouped.map((u) => (
                    <li key={u.relativePath}>
                      {u.name} — {u.classification.replaceAll('_', ' ')}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {preview.skipped.length > 0 && (
              <div style={{ margin: '8px 0' }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  Skipped ({preview.skipped.length})
                </div>
                <ul className="muted" style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>
                  {preview.skipped.map((s, i) => (
                    <li key={s.relativePath + i}>
                      {s.relativePath} — {s.reason.replaceAll('_', ' ')}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="row" style={{ marginTop: 12 }}>
              <button
                className="btn primary"
                onClick={confirmPathImport}
                disabled={pathBusy || preview.totalFiles === 0 || preview.truncated}
              >
                {pathBusy ? 'Importing…' : `Confirm import (${preview.totalFiles} files)`}
              </button>
              <button className="btn" onClick={() => setPreview(null)} disabled={pathBusy}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

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
          {resultSkipped.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h3 className="card-title">Skipped by the folder walk</h3>
              {resultSkipped.map((s, i) => (
                <p key={s.relativePath + i} style={{ margin: '4px 0', fontSize: 12 }}>
                  <span className="badge warn">{s.reason.replaceAll('_', ' ')}</span>{' '}
                  <span className="muted">{s.relativePath}</span>
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
