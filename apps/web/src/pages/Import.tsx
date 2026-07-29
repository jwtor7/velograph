import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  api,
  type FolderPreviewBody,
  type FolderSkipItem,
  type ImportInventoryItem,
  type ImportResultBody,
} from '../api.ts';
import {
  createPickedFiles,
  encodePickedFilesSequentially,
  inventoryMatchesSelection,
  isAbortError,
  validateImportSelection,
  type ImportSelectionError,
  type PickedImportFile,
} from './import-files.ts';
import { resolveDroppedFolderPath, type DroppedFolderFile } from './import-folder-drop.ts';
import { requestCurrentFolderPreview } from './import-preview.ts';

const ACCEPT = '.csv,.gpx,.zip';
const STALE_FOLDER_PREVIEW_CODES = new Set([
  'path_changed',
  'file_changed',
  'path_not_found',
  'not_a_directory',
]);

function selectionErrorMessage(code: ImportSelectionError): string {
  if (code === 'import_file_count_exceeded') {
    return 'Too many files for browser upload. Use folder path import for a large export.';
  }
  if (code === 'import_file_too_large') {
    return 'A selected file is too large for browser upload. Use folder path import instead.';
  }
  return 'The selected files are too large for browser upload. Use folder path import instead.';
}

function uploadErrorMessage(err: unknown): string {
  if (isAbortError(err) || (err instanceof ApiError && err.code === 'import_cancelled')) {
    return 'Import cancelled.';
  }
  if (!(err instanceof ApiError)) {
    return 'Import failed. Check that the local API is running, then try again.';
  }
  if (
    err.code === 'import_body_too_large' ||
    err.code === 'import_file_count_exceeded' ||
    err.code === 'import_file_too_large' ||
    err.code === 'import_total_size_exceeded'
  ) {
    return 'This selection exceeds the safe browser-upload limit. Use folder path import instead.';
  }
  if (
    err.code === 'invalid_import_payload' ||
    err.code === 'invalid_base64' ||
    err.code === 'duplicate_file_id'
  ) {
    return 'The file review expired or became invalid. Clear the selection and choose the files again.';
  }
  return 'Import failed. Check that the local API is running, then try again.';
}

/**
 * Recursively read every file entry under a dropped `FileSystemEntry`, while
 * constructing a relative path from entry names. The virtual `entry.fullPath`
 * is intentionally ignored because it is not an OS path.
 */
function readEntryFiles(
  entry: FileSystemEntry,
  relativeParent = '',
  droppedRoot = true,
): Promise<DroppedFolderFile[]> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      (entry as FileSystemFileEntry).file(
        (file) =>
          resolve([
            {
              file,
              relativePath: [relativeParent, entry.name].filter(Boolean).join('/'),
            },
          ]),
        () => resolve([]),
      );
      return;
    }
    if (!entry.isDirectory) {
      resolve([]);
      return;
    }
    const childParent = droppedRoot
      ? relativeParent
      : [relativeParent, entry.name].filter(Boolean).join('/');
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const collected: DroppedFolderFile[] = [];
    const readBatch = () => {
      reader.readEntries(
        (entries) => {
          if (entries.length === 0) {
            resolve(collected);
            return;
          }
          Promise.all(entries.map((child) => readEntryFiles(child, childParent, false)))
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
  const [picked, setPicked] = useState<PickedImportFile[]>([]);
  const [inventory, setInventory] = useState<ImportInventoryItem[] | null>(null);
  const [inventoryBusy, setInventoryBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResultBody | null>(null);
  const [resultSkipped, setResultSkipped] = useState<FolderSkipItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextFileIdRef = useRef(1);
  const selectionVersionRef = useRef(0);
  const fileOperationRef = useRef<AbortController | null>(null);

  const [folderPath, setFolderPath] = useState('');
  const folderPathRef = useRef('');
  const [preview, setPreview] = useState<FolderPreviewBody | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pathBusy, setPathBusy] = useState(false);
  const pathOperationRef = useRef<AbortController | null>(null);
  const fileOperationBusy = busy || inventoryBusy;
  const pathOperationBusy = previewBusy || pathBusy;

  useEffect(
    () => () => {
      fileOperationRef.current?.abort();
      pathOperationRef.current?.abort();
    },
    [],
  );

  const addFiles = (files: FileList | File[], notice: string | null = null) => {
    if (fileOperationBusy || pathOperationBusy) {
      setError(
        'Wait for the current review, scan, or import to finish before changing the selection.',
      );
      return;
    }
    setDropNotice(notice);
    setPicked((prev) => {
      const created = createPickedFiles(files, nextFileIdRef.current);
      const merged = [...prev, ...created.files];
      const validation = validateImportSelection(merged);
      if (validation) {
        setError(selectionErrorMessage(validation));
        return prev;
      }
      nextFileIdRef.current = created.nextId;
      selectionVersionRef.current++;
      setInventory(null);
      setInventoryBusy(false);
      setError(null);
      return merged;
    });
    setResult(null);
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
      const groups = await Promise.all(entries.map((entry) => readEntryFiles(entry)));
      const droppedFiles = groups.flat();
      const folderPath =
        entries.length === 1 && entries[0]!.isDirectory
          ? resolveDroppedFolderPath(droppedFiles)
          : null;
      if (folderPath) {
        selectionVersionRef.current++;
        setPicked([]);
        setInventory(null);
        setError(null);
        setDropNotice(
          'Folder path detected by this local desktop runtime. Previewing it directly from disk.',
        );
        folderPathRef.current = folderPath;
        setFolderPath(folderPath);
        setPreview(null);
        await loadPreviewForPath(folderPath);
        return;
      }
      addFiles(
        droppedFiles.map(({ file }) => file),
        'This browser does not expose one verified absolute folder path. Velograph added the bounded loose files it could read; paste the path below for a large export.',
      );
      return;
    }
    addFiles(e.dataTransfer.files);
  };

  const reviewFiles = async () => {
    if (pathOperationBusy) {
      setError('Wait for the folder operation to finish before reviewing files.');
      return;
    }
    const selected = picked;
    const validation = validateImportSelection(selected);
    if (validation) {
      setError(selectionErrorMessage(validation));
      return;
    }
    const version = selectionVersionRef.current;
    const controller = new AbortController();
    fileOperationRef.current = controller;
    setInventoryBusy(true);
    setError(null);
    try {
      const files = await encodePickedFilesSequentially(selected, { signal: controller.signal });
      const response = await api.importInventory(files, controller.signal);
      if (
        version !== selectionVersionRef.current ||
        !inventoryMatchesSelection(selected, response.inventory)
      ) {
        return;
      }
      setInventory(response.inventory);
    } catch (err) {
      if (version === selectionVersionRef.current) {
        setError(uploadErrorMessage(err));
      }
    } finally {
      if (fileOperationRef.current === controller) fileOperationRef.current = null;
      if (version === selectionVersionRef.current) {
        setInventoryBusy(false);
      }
    }
  };

  const runImport = async () => {
    if (pathOperationBusy) {
      setError('Wait for the folder operation to finish before importing files.');
      return;
    }
    if (!inventory || !inventoryMatchesSelection(picked, inventory)) {
      setInventory(null);
      setError('Review the current file selection before confirming the import.');
      return;
    }
    const controller = new AbortController();
    fileOperationRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      const files = await encodePickedFilesSequentially(picked, { signal: controller.signal });
      const res = await api.importFiles(files, controller.signal);
      setResult(res.result);
      setResultSkipped([]);
      setPicked([]);
      setInventory(null);
      selectionVersionRef.current++;
    } catch (err) {
      setError(uploadErrorMessage(err));
    } finally {
      if (fileOperationRef.current === controller) fileOperationRef.current = null;
      setBusy(false);
    }
  };

  async function loadPreviewForPath(requestedPath: string) {
    if (fileOperationBusy) {
      setPreviewError('Wait for the file operation to finish before scanning a folder.');
      return;
    }
    const normalizedRequestedPath = requestedPath.trim();
    const controller = new AbortController();
    pathOperationRef.current = controller;
    setPreviewBusy(true);
    setPreviewError(null);
    setResult(null);
    try {
      const res = await requestCurrentFolderPreview(
        normalizedRequestedPath,
        () => folderPathRef.current,
        (path) => api.importPathPreview(path, controller.signal),
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
    } catch (err) {
      setPreview(null);
      if (isAbortError(err) || (err instanceof ApiError && err.code === 'import_cancelled')) {
        setPreviewError('Folder scan cancelled.');
      } else {
        setPreviewError(
          'Could not read that folder. Check the path, that it exists, and that it is outside ' +
            'the Velograph source checkout.',
        );
      }
    } finally {
      if (pathOperationRef.current === controller) {
        pathOperationRef.current = null;
        setPreviewBusy(false);
      }
    }
  }

  const loadPreview = async () => loadPreviewForPath(folderPath);

  const confirmPathImport = async () => {
    if (fileOperationBusy) {
      setPreviewError('Wait for the file operation to finish before importing a folder.');
      return;
    }
    const controller = new AbortController();
    pathOperationRef.current = controller;
    setPathBusy(true);
    setPreviewError(null);
    try {
      if (!preview || preview.truncated || !preview.preflightComplete) {
        setPreviewError(
          'A complete file review is required before importing. Preview the folder again.',
        );
        return;
      }
      const res = await api.importPath(
        folderPath.trim(),
        preview.confirmationToken,
        controller.signal,
      );
      setResult(res.result);
      setResultSkipped(res.skipped);
      setPreview(null);
      folderPathRef.current = '';
      setFolderPath('');
    } catch (err) {
      if (isAbortError(err) || (err instanceof ApiError && err.code === 'import_cancelled')) {
        setPreviewError('Import cancelled.');
      } else if (err instanceof ApiError && STALE_FOLDER_PREVIEW_CODES.has(err.code)) {
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
      if (pathOperationRef.current === controller) {
        pathOperationRef.current = null;
        setPathBusy(false);
      }
    }
  };

  const clearPickedFiles = () => {
    selectionVersionRef.current++;
    setPicked([]);
    setInventory(null);
    setInventoryBusy(false);
    setError(null);
  };

  const removePickedFile = (id: string) => {
    selectionVersionRef.current++;
    setPicked((current) => current.filter((file) => file.id !== id));
    setInventory(null);
    setInventoryBusy(false);
    setError(null);
  };

  const inventoryById = new Map(inventory?.map((item) => [item.id, item]) ?? []);

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
        role="group"
        aria-label="File import drop area"
        aria-disabled={fileOperationBusy || pathOperationBusy}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => void handleDrop(e)}
      >
        <p style={{ margin: 0, fontSize: 15 }}>
          Drop your export files or folder here, or use the file chooser.
        </p>
        <p className="muted" style={{ margin: '6px 0 12px', fontSize: 12 }}>
          One CSV contains one metric. Drop the whole export folder or every companion file for a
          complete ride — or paste the folder path below for a large export.
        </p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <button
            type="button"
            className="btn"
            disabled={fileOperationBusy || pathOperationBusy}
            onClick={() => inputRef.current?.click()}
          >
            Choose files
          </button>
        </div>
        <p style={{ margin: '10px 0 0', fontSize: 11 }}>.csv · .gpx · .zip</p>
        {dropNotice && (
          <p className="muted" role="status" style={{ margin: '10px 0 0', fontSize: 12 }}>
            {dropNotice}
          </p>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          disabled={fileOperationBusy || pathOperationBusy}
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.currentTarget.value = '';
          }}
        />
      </div>

      {picked.length > 0 && (
        <div className="card">
          <h2 className="card-title">Selected files ({picked.length})</h2>
          <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
            Review asks the local API to identify every exact file before import. Distinct files are
            preserved even when their names and sizes match.
          </p>
          <table className="data">
            <thead>
              <tr>
                <th>File</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Size</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {picked.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>
                    {inventoryById.has(p.id) ? (
                      <>
                        <span
                          className={`badge ${
                            inventoryById.get(p.id)!.classification === 'recognized' ? '' : 'warn'
                          }`}
                        >
                          {inventoryById.get(p.id)!.classification.replaceAll('_', ' ')}
                        </span>
                        {inventoryById
                          .get(p.id)!
                          .outcomes.filter(
                            (outcome) =>
                              inventoryById.get(p.id)!.classification === 'mixed' ||
                              outcome.classification === 'invalid' ||
                              outcome.classification === 'ambiguous' ||
                              outcome.count > 1,
                          )
                          .map((outcome, index) => (
                            <span
                              key={`${outcome.classification}-${outcome.code ?? 'none'}-${index}`}
                              className="muted"
                              style={{ marginLeft: 6, fontSize: 11 }}
                            >
                              {outcome.count > 1 ? `${outcome.count}× ` : ''}
                              {outcome.classification.replaceAll('_', ' ')}
                              {outcome.code ? ` · ${outcome.code.replaceAll('_', ' ')}` : ''}
                            </span>
                          ))}
                        {inventoryById.get(p.id)!.detectedType && (
                          <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>
                            {inventoryById
                              .get(p.id)!
                              .detectedType!.replaceAll('_', ' ')
                              .replaceAll(':', ' · ')}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="muted">Awaiting review</span>
                    )}
                  </td>
                  <td className="muted" style={{ textAlign: 'right' }}>
                    {(p.size / 1024).toFixed(1)} KB
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => removePickedFile(p.id)}
                      disabled={fileOperationBusy || pathOperationBusy}
                      aria-label={`Remove ${p.name}`}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}>
            {inventory ? (
              <button
                className="btn primary"
                onClick={runImport}
                disabled={fileOperationBusy || pathOperationBusy}
              >
                {busy ? 'Importing…' : 'Confirm import'}
              </button>
            ) : (
              <button
                className="btn primary"
                onClick={reviewFiles}
                disabled={fileOperationBusy || pathOperationBusy}
              >
                {inventoryBusy ? 'Reviewing…' : 'Review files'}
              </button>
            )}
            <button
              className="btn"
              onClick={clearPickedFiles}
              disabled={fileOperationBusy || pathOperationBusy}
            >
              Clear
            </button>
            {(busy || inventoryBusy) && (
              <button className="btn" onClick={() => fileOperationRef.current?.abort()}>
                {busy ? 'Cancel import' : 'Cancel review'}
              </button>
            )}
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
            disabled={fileOperationBusy || pathOperationBusy}
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
            disabled={fileOperationBusy || pathOperationBusy || !folderPath.trim()}
          >
            {previewBusy ? 'Scanning…' : 'Preview folder'}
          </button>
          {previewBusy && (
            <button className="btn" onClick={() => pathOperationRef.current?.abort()}>
              Cancel scan
            </button>
          )}
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

            {preview.preflightComplete ? (
              <div style={{ margin: '8px 0' }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  Exact file review ({preview.preflight.length})
                </div>
                <ul className="muted" style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>
                  {preview.preflight.map((item, index) => (
                    <li key={`${item.name}-${index}`}>
                      {item.name} — {item.classification.replaceAll('_', ' ')}
                      {item.outcomes
                        .filter(
                          (outcome) =>
                            item.classification === 'mixed' ||
                            outcome.classification === 'invalid' ||
                            outcome.classification === 'ambiguous' ||
                            outcome.count > 1,
                        )
                        .map(
                          (outcome) =>
                            ` · ${outcome.count > 1 ? `${outcome.count}× ` : ''}${
                              outcome.code?.replaceAll('_', ' ') ??
                              outcome.classification.replaceAll('_', ' ')
                            }`,
                        )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p style={{ fontSize: 12, color: 'var(--vg-ch-hr)' }}>
                Exact parser and duplicate review is incomplete. Import is disabled.
              </p>
            )}

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
                disabled={
                  fileOperationBusy ||
                  pathBusy ||
                  preview.totalFiles === 0 ||
                  preview.truncated ||
                  !preview.preflightComplete
                }
              >
                {pathBusy ? 'Importing…' : `Confirm import (${preview.totalFiles} files)`}
              </button>
              <button
                className="btn"
                onClick={() => (pathBusy ? pathOperationRef.current?.abort() : setPreview(null))}
              >
                {pathBusy ? 'Cancel import' : 'Cancel'}
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
              <div className="kpi-label">Out-of-scope skipped</div>
              <div className="kpi-value">{result.skipped}</div>
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
          {result.skipped > 0 && (
            <p className="muted" style={{ margin: '12px 0 0', fontSize: 12 }}>
              {result.skippedByCode.unmodelled_metric} unmodelled cycling metric
              {result.skippedByCode.unmodelled_metric === 1 ? '' : 's'} ·{' '}
              {result.skippedByCode.non_cycling_workout} non-cycling workout file
              {result.skippedByCode.non_cycling_workout === 1 ? '' : 's'}
            </p>
          )}
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
