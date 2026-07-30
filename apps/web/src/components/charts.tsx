import { useId, useRef } from 'react';
import type { Pt } from '../chartspec/spec.ts';
import { buildLineSpec, timeAtX, valueAt } from '../chartspec/spec.ts';

/**
 * SVG time-series tile with area fill and optional synchronized cursor
 * (RIDE-004). Rendering is a pure function of props — the spec builders are
 * deterministic and tested; this component only paints them.
 */
export function TimeSeriesChart({
  title,
  points,
  color,
  unit,
  format,
  tMin,
  tMax,
  cursorT,
  onCursor,
  height = 90,
}: {
  title: string;
  points: Pt[];
  color: string;
  unit: string;
  format: (v: number) => string;
  tMin: number;
  tMax: number;
  cursorT: number | null;
  onCursor?: (t: number | null) => void;
  height?: number;
}) {
  const W = 560;
  const gradId = useId();
  const helpId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const spec = buildLineSpec(points, W, height, { tMin, tMax });
  const cursorValue = cursorT != null ? valueAt(points, cursorT) : null;
  const headValue =
    cursorValue != null
      ? format(cursorValue)
      : points.length
        ? format(points[points.length - 1]!.v)
        : '–';

  const cursorX =
    cursorT != null && spec ? ((cursorT - spec.tMin) / (spec.tMax - spec.tMin)) * W : null;
  const keyboardT = spec ? (cursorT ?? spec.tMin) : null;
  const keyboardValue = keyboardT == null ? null : valueAt(points, keyboardT);
  const keyboardValueText =
    spec && keyboardT != null
      ? `${Math.max(0, Math.round((keyboardT - spec.tMin) / 1000))} seconds into ride${
          keyboardValue == null ? '' : `, ${format(keyboardValue)} ${unit}`
        }`
      : undefined;

  return (
    <div className="card">
      <div className="chart-tile-head">
        <span className="chart-tile-title">{title}</span>
        <span className="chart-tile-value" style={{ color }}>
          {headValue}{' '}
          <span className="muted" style={{ fontWeight: 500 }}>
            {unit}
          </span>
        </span>
      </div>
      {spec ? (
        <>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${height}`}
            width="100%"
            role={onCursor ? 'slider' : 'img'}
            aria-label={onCursor ? `${title} time cursor` : `${title} chart`}
            aria-describedby={onCursor ? helpId : undefined}
            aria-valuemin={onCursor ? spec.tMin : undefined}
            aria-valuemax={onCursor ? spec.tMax : undefined}
            aria-valuenow={onCursor && keyboardT != null ? keyboardT : undefined}
            aria-valuetext={onCursor ? keyboardValueText : undefined}
            aria-keyshortcuts={
              onCursor ? 'ArrowLeft ArrowRight PageUp PageDown Home End Escape' : undefined
            }
            tabIndex={onCursor ? 0 : undefined}
            style={{ display: 'block' }}
            onFocus={() => {
              if (cursorT == null) onCursor?.(spec.tMin);
            }}
            onBlur={() => onCursor?.(null)}
            onKeyDown={(event) => {
              if (!onCursor) return;
              const step = Math.max(1, Math.round((spec.tMax - spec.tMin) / 100));
              const pageStep = step * 10;
              const current = cursorT ?? spec.tMin;
              let next: number | null | undefined;
              switch (event.key) {
                case 'ArrowLeft':
                case 'ArrowDown':
                  next = current - step;
                  break;
                case 'ArrowRight':
                case 'ArrowUp':
                  next = current + step;
                  break;
                case 'PageDown':
                  next = current - pageStep;
                  break;
                case 'PageUp':
                  next = current + pageStep;
                  break;
                case 'Home':
                  next = spec.tMin;
                  break;
                case 'End':
                  next = spec.tMax;
                  break;
                case 'Escape':
                  next = null;
                  break;
                default:
                  return;
              }
              event.preventDefault();
              onCursor(
                next == null ? null : Math.max(spec.tMin, Math.min(spec.tMax, Math.round(next))),
              );
            }}
            onMouseMove={(e) => {
              if (!onCursor || !svgRef.current) return;
              const rect = svgRef.current.getBoundingClientRect();
              const x = ((e.clientX - rect.left) / rect.width) * W;
              onCursor(timeAtX(x, W, spec.tMin, spec.tMax));
            }}
            onMouseLeave={() => {
              if (document.activeElement !== svgRef.current) onCursor?.(null);
            }}
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={color} stopOpacity="0.28" />
                <stop offset="1" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={spec.area} fill={`url(#${gradId})`} />
            <path d={spec.path} fill="none" stroke={color} strokeWidth="1.6" />
            {cursorX != null && (
              <line
                x1={cursorX}
                y1="0"
                x2={cursorX}
                y2={height}
                stroke="var(--vg-text-muted)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
            )}
          </svg>
          {onCursor ? (
            <span id={helpId} className="visually-hidden">
              Use Left and Right arrows for fine movement, Page Up and Page Down for larger
              movement, Home and End for ride bounds, and Escape to clear the cursor.
            </span>
          ) : null}
        </>
      ) : (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          No data recorded for this ride.
        </p>
      )}
    </div>
  );
}

export function BarChart({
  items,
  color,
  height = 120,
  format,
  unavailableText = 'Unavailable',
}: {
  items: { label: string; value: number | null }[];
  color: string;
  height?: number;
  format: (v: number) => string;
  unavailableText?: string;
}) {
  const W = 560;
  const max = items.reduce(
    (maximum, item) => (item.value == null ? maximum : Math.max(maximum, item.value)),
    1,
  );
  const bw = W / Math.max(items.length, 1);
  return (
    <svg viewBox={`0 0 ${W} ${height + 18}`} width="100%" role="img" aria-label="bar chart">
      {items.map((item, i) => {
        const h = item.value == null ? null : (item.value / max) * height;
        const visibleHeight = h === 0 ? 2 : h;
        return (
          <g key={`${item.label}-${i}`}>
            {item.value == null || visibleHeight == null ? (
              <>
                <line
                  x1={i * bw + bw * 0.2}
                  y1={height - 1}
                  x2={i * bw + bw * 0.8}
                  y2={height - 1}
                  stroke="var(--vg-text-muted)"
                  strokeWidth="2"
                  strokeDasharray="3 3"
                >
                  <title>{`${item.label}: ${unavailableText}`}</title>
                </line>
                <text
                  x={i * bw + bw / 2}
                  y={height - 6}
                  textAnchor="middle"
                  fontSize="9"
                  fill="var(--vg-text-muted)"
                >
                  n/a
                </text>
              </>
            ) : (
              <rect
                x={i * bw + bw * 0.15}
                y={height - visibleHeight}
                width={bw * 0.7}
                height={visibleHeight}
                rx="3"
                fill={color}
                opacity="0.85"
              >
                <title>{`${item.label}: ${format(item.value)}`}</title>
              </rect>
            )}
            <text
              x={i * bw + bw / 2}
              y={height + 13}
              textAnchor="middle"
              fontSize="9"
              fill="var(--vg-text-muted)"
            >
              {item.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
