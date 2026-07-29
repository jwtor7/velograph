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
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${height}`}
          width="100%"
          role="img"
          aria-label={`${title} chart`}
          style={{ display: 'block' }}
          onMouseMove={(e) => {
            if (!onCursor || !svgRef.current) return;
            const rect = svgRef.current.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * W;
            onCursor(timeAtX(x, W, spec.tMin, spec.tMax));
          }}
          onMouseLeave={() => onCursor?.(null)}
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
}: {
  items: { label: string; value: number }[];
  color: string;
  height?: number;
  format: (v: number) => string;
}) {
  const W = 560;
  const max = Math.max(...items.map((i) => i.value), 1);
  const bw = W / Math.max(items.length, 1);
  return (
    <svg viewBox={`0 0 ${W} ${height + 18}`} width="100%" role="img" aria-label="bar chart">
      {items.map((item, i) => {
        const h = (item.value / max) * height;
        return (
          <g key={item.label}>
            <rect
              x={i * bw + bw * 0.15}
              y={height - h}
              width={bw * 0.7}
              height={h}
              rx="3"
              fill={color}
              opacity="0.85"
            >
              <title>{`${item.label}: ${format(item.value)}`}</title>
            </rect>
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
