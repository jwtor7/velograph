import { useId } from 'react';
import type { RoutePoint } from '../api.ts';
import {
  buildRouteSpec,
  buildSegmentedLineSpec,
  routeIndexAt,
  type Pt,
} from '../chartspec/spec.ts';

/**
 * Tile-free route canvas (ROUTE-002/003/004): recorded geometry over a neutral
 * grid, gradient polyline start→finish, segment gaps preserved, position
 * cursor synchronized with the charts. Zero network requests.
 */
export function RoutePanel({
  segments,
  cursorT,
  height = 320,
}: {
  segments: { points: RoutePoint[] }[];
  cursorT: number | null;
  height?: number;
}) {
  const W = 560;
  const gradId = useId();
  const spec = buildRouteSpec(segments, W, height, 24);
  if (!spec) {
    return (
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        No route recorded for this ride.
      </p>
    );
  }

  let cursorPos: [number, number] | null = null;
  if (cursorT != null) {
    const idx = routeIndexAt(segments, cursorT);
    if (idx != null) {
      const flat = segments.flatMap((s) => s.points);
      const p = flat[idx];
      if (p) cursorPos = spec.project(p.lat, p.lon);
    }
  }

  const gridLines = [];
  for (let x = 40; x < W; x += 40)
    gridLines.push(<line key={`v${x}`} x1={x} y1={0} x2={x} y2={height} />);
  for (let y = 40; y < height; y += 40)
    gridLines.push(<line key={`h${y}`} x1={0} y1={y} x2={W} y2={y} />);

  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      width="100%"
      role="img"
      aria-label="offline route map with direction, distance, and scale markers"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--vg-route-start)" />
          <stop offset="1" stopColor="var(--vg-route-end)" />
        </linearGradient>
      </defs>
      <g stroke="var(--vg-border)" strokeWidth="0.5" opacity="0.6">
        {gridLines}
      </g>
      {spec.segmentPaths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {spec.directionMarkers.map((marker, i) => (
        <g
          key={`direction-${i}`}
          transform={`translate(${marker.position[0]} ${marker.position[1]}) rotate(${marker.angleDeg})`}
          aria-hidden="true"
        >
          <path
            d="M-5 -4L6 0L-5 4L-2 0Z"
            fill="var(--vg-brand-teal)"
            stroke="var(--vg-bg)"
            strokeWidth="1.2"
          />
        </g>
      ))}
      {spec.distanceMarkers.map((marker) => (
        <g
          key={`distance-${marker.distanceM}`}
          transform={`translate(${marker.position[0]} ${marker.position[1]})`}
        >
          <circle r="3.5" fill="var(--vg-bg)" stroke="var(--vg-text)" strokeWidth="1.2" />
          <text
            x="6"
            y="-6"
            fill="var(--vg-text)"
            stroke="var(--vg-bg)"
            strokeWidth="3"
            paintOrder="stroke"
            fontSize="9"
            fontWeight="600"
          >
            {marker.label}
          </text>
        </g>
      ))}
      {spec.start && (
        <circle
          cx={spec.start[0]}
          cy={spec.start[1]}
          r="5"
          fill="var(--vg-route-start)"
          stroke="var(--vg-bg)"
          strokeWidth="2"
        />
      )}
      {spec.finish && (
        <circle
          cx={spec.finish[0]}
          cy={spec.finish[1]}
          r="5"
          fill="var(--vg-bg)"
          stroke="#fff"
          strokeWidth="2"
        />
      )}
      {cursorPos && (
        <circle
          cx={cursorPos[0]}
          cy={cursorPos[1]}
          r="6"
          fill="none"
          stroke="var(--vg-brand-teal)"
          strokeWidth="2"
        />
      )}
      <g transform={`translate(24 ${height - 20})`} aria-label={`scale ${spec.scaleBar.label}`}>
        <line
          x1="0"
          y1="0"
          x2={spec.scaleBar.widthPx}
          y2="0"
          stroke="var(--vg-text)"
          strokeWidth="2"
        />
        <line x1="0" y1="-4" x2="0" y2="4" stroke="var(--vg-text)" strokeWidth="1.5" />
        <line
          x1={spec.scaleBar.widthPx}
          y1="-4"
          x2={spec.scaleBar.widthPx}
          y2="4"
          stroke="var(--vg-text)"
          strokeWidth="1.5"
        />
        <text x="0" y="-7" fill="var(--vg-text-muted)" fontSize="9" fontWeight="600">
          {spec.scaleBar.label}
        </text>
      </g>
      <g transform={`translate(${W - 26} 28)`} aria-label="north">
        <path d="M0 -12L5 6L0 3L-5 6Z" fill="var(--vg-text)" />
        <text x="0" y="17" textAnchor="middle" fill="var(--vg-text-muted)" fontSize="9">
          N
        </text>
      </g>
    </svg>
  );
}

export function ElevationProfile({
  segments,
  cursorT,
  tMin,
  tMax,
  height = 110,
}: {
  segments: { points: RoutePoint[] }[];
  cursorT: number | null;
  tMin: number;
  tMax: number;
  height?: number;
}) {
  const W = 560;
  const gradId = useId();
  const elevationSegments: Pt[][] = [];
  for (const segment of segments) {
    let run: Pt[] = [];
    for (const point of segment.points) {
      if (
        typeof point.t === 'number' &&
        Number.isFinite(point.t) &&
        typeof point.ele === 'number' &&
        Number.isFinite(point.ele)
      ) {
        run.push({ t: point.t, v: point.ele });
      } else if (run.length > 0) {
        elevationSegments.push(run);
        run = [];
      }
    }
    if (run.length > 0) elevationSegments.push(run);
  }
  const spec = buildSegmentedLineSpec(elevationSegments, W, height, { tMin, tMax });
  if (!spec) {
    return (
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        No elevation data recorded.
      </p>
    );
  }
  const cursorX = cursorT != null ? ((cursorT - spec.tMin) / (spec.tMax - spec.tMin)) * W : null;
  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label="elevation profile">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--vg-ch-elevation-fill)" stopOpacity="0.8" />
          <stop offset="1" stopColor="var(--vg-ch-elevation-fill)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={spec.area} fill={`url(#${gradId})`} />
      <path d={spec.path} fill="none" stroke="var(--vg-ch-elevation)" strokeWidth="1.6" />
      {cursorX != null && cursorX >= 0 && cursorX <= W && (
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
  );
}

const ZONE_COLORS = [
  'var(--vg-z1)',
  'var(--vg-z2)',
  'var(--vg-z3)',
  'var(--vg-z4)',
  'var(--vg-z5)',
  'var(--vg-z6)',
];

export function ZoneStrip({
  zones,
}: {
  zones: { zone: number; label: string; seconds: number; share: number }[];
}) {
  const fmt = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(Math.floor(s % 60)).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };
  return (
    <div className="zone-strip">
      {zones.map((z, i) => (
        <div className="zone-cell" key={z.zone}>
          <div className="zone-label">{z.label}</div>
          <div className="zone-time">
            {fmt(z.seconds)}{' '}
            <span className="muted" style={{ fontWeight: 500, fontSize: 11 }}>
              {Math.round(z.share * 100)}%
            </span>
          </div>
          <div className="zone-bar">
            <div
              style={{
                width: `${Math.max(2, z.share * 100)}%`,
                background: ZONE_COLORS[i] ?? 'var(--vg-z6)',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
