import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true',
  );
}

/** Brand logomark: the cover art's twin-facet V in the blue→teal gradient. */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="vg-brand" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--vg-brand-blue)" />
          <stop offset="0.6" stopColor="var(--vg-brand-teal)" />
          <stop offset="1" stopColor="var(--vg-brand-green)" />
        </linearGradient>
      </defs>
      <path d="M2 4h5.2L12 14.6 16.8 4H22l-8.4 17h-3.2Z" fill="url(#vg-brand)" />
      <path d="M9.4 4h3.4l-1.7 3.8Z" fill="var(--vg-brand-teal)" opacity="0.9" />
    </svg>
  );
}

export function Kpi({
  label,
  value,
  unit,
  color,
  icon,
}: {
  label: string;
  value: string;
  unit?: string;
  color?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="kpi">
      <div className="kpi-label" style={color ? { color } : undefined}>
        {icon}
        <span style={{ color: 'var(--vg-text-muted)' }}>{label}</span>
      </div>
      <div className="kpi-value">
        {value}
        {unit ? <span className="kpi-unit">{unit}</span> : null}
      </div>
    </div>
  );
}

export function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: 999,
        background: color,
      }}
    />
  );
}

/**
 * Blocking confirmation dialog (used by ride delete / restore, issue #38):
 * always states what will happen before an irreversible action fires.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (cancelRef.current && !cancelRef.current.disabled) {
      cancelRef.current.focus();
    } else {
      dialogRef.current?.focus();
    }

    return () => {
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (
      busy &&
      dialogRef.current?.contains(document.activeElement) &&
      document.activeElement instanceof HTMLButtonElement &&
      document.activeElement.disabled
    ) {
      dialogRef.current.focus();
    }
  }, [busy]);

  const requestCancel = () => {
    if (!busy) onCancel();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      requestCancel();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;

    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (
      event.shiftKey &&
      (document.activeElement === first || !dialogRef.current.contains(document.activeElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || !dialogRef.current.contains(document.activeElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) requestCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId} className="card-title" style={{ fontSize: 15 }}>
          {title}
        </h2>
        <div id={bodyId} className="modal-body">
          {body}
        </div>
        <div className="modal-actions">
          <button ref={cancelRef} className="btn" onClick={requestCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? 'danger' : 'primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
      <p style={{ margin: '0 0 12px' }} className="muted">
        {title}
      </p>
      {action}
    </div>
  );
}
