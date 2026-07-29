import type { ReactNode } from 'react';

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
  return (
    <div className="modal-overlay" role="presentation" onClick={onCancel}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="card-title" style={{ fontSize: 15 }}>
          {title}
        </h2>
        <div className="modal-body">{body}</div>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
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
