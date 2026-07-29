import type { RoutePoint, RouteSegment } from '@velograph/shared';
import { parseInstant } from '@velograph/shared';

/**
 * Secure, namespace-tolerant GPX parser (ROUTE-001, ROUTE-005).
 *
 * Security posture:
 *  - Any DTD/ENTITY declaration is rejected outright — external entities and
 *    entity expansion cannot occur because nothing is ever expanded beyond the
 *    five predefined XML entities.
 *  - Hard resource limits: input size, point count, element nesting depth.
 *  - Coordinates, timestamps, and elevations are range-validated; invalid
 *    points are dropped and counted, never guessed.
 *
 * This is a purpose-built parser for the GPX track subset (trk/trkseg/trkpt,
 * ele, time, and speed/course extensions), versioned via GPX_PARSER_VERSION so
 * files can be reprocessed after upgrades (IMP-010).
 */
export const GPX_PARSER_VERSION = 'gpx-v1';

export interface GpxLimits {
  maxBytes: number;
  maxPoints: number;
  maxDepth: number;
}

export const DEFAULT_GPX_LIMITS: GpxLimits = {
  maxBytes: 50 * 1024 * 1024,
  maxPoints: 500_000,
  maxDepth: 32,
};

export type GpxErrorCode = 'xml_doctype_rejected' | 'gpx_limits_exceeded' | 'malformed_xml';

export class GpxError extends Error {
  readonly code: GpxErrorCode;

  constructor(code: GpxErrorCode, message: string) {
    super(message);
    this.name = 'GpxError';
    this.code = code;
  }
}

export interface GpxResult {
  segments: RouteSegment[];
  droppedPoints: number;
}

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

const decodeEntities = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITY_MAP[m]!);

const localName = (tag: string) => {
  const idx = tag.indexOf(':');
  return idx === -1 ? tag : tag.slice(idx + 1);
};

export function parseGpx(input: string, limits: GpxLimits = DEFAULT_GPX_LIMITS): GpxResult {
  if (input.length > limits.maxBytes) {
    throw new GpxError('gpx_limits_exceeded', 'input exceeds size limit');
  }
  if (/<!(DOCTYPE|ENTITY)/i.test(input)) {
    throw new GpxError('xml_doctype_rejected', 'DTD and entity declarations are not allowed');
  }

  // Tokenize tags; text content is only consulted inside ele/time/extension tags.
  const tagRe =
    /<\/?([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/g;

  const segments: RouteSegment[] = [];
  let current: RoutePoint[] | null = null;
  let point: Partial<RoutePoint> | null = null;
  let dropped = 0;
  let totalPoints = 0;
  let depth = 0;
  let sawGpxRoot = false;
  const stack: string[] = [];
  let lastIndex = 0;
  let textTarget: 'ele' | 'time' | 'speed' | 'course' | null = null;
  let textStart = -1;

  const openPointField = (name: string, index: number) => {
    if (!point) return;
    if (name === 'ele' || name === 'time' || name === 'speed' || name === 'course') {
      textTarget = name;
      textStart = index;
    }
  };

  const closePointField = (name: string, index: number, raw: string) => {
    if (!point || !textTarget || localName(name) !== textTarget) return;
    const text = decodeEntities(raw.slice(textStart, index)).trim();
    if (textTarget === 'ele') {
      const v = Number(text);
      if (Number.isFinite(v) && v > -500 && v < 10_000) point.ele = v;
    } else if (textTarget === 'time') {
      const t = parseInstant(text.replace(/Z$/, 'Z'));
      if (t != null) point.t = t;
    } else if (textTarget === 'speed') {
      const v = Number(text);
      if (Number.isFinite(v) && v >= 0 && v < 150) point.speed = v;
    } else if (textTarget === 'course') {
      const v = Number(text);
      if (Number.isFinite(v) && v >= 0 && v < 360) point.course = v;
    }
    textTarget = null;
    textStart = -1;
  };

  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(input)) !== null) {
    if (m[1] === undefined) continue; // comment / PI / CDATA — ignored
    const rawTag = m[0];
    const name = localName(m[1]);
    const attrs = m[2] ?? '';
    const selfClosing = m[3] === '/';
    const isClose = rawTag.startsWith('</');

    if (isClose) {
      closePointField(m[1], m.index, input);
      const expected = stack.pop();
      depth--;
      if (expected === undefined) throw new GpxError('malformed_xml', 'unbalanced closing tag');
      if (name === 'trkpt' && point) {
        totalPoints++;
        if (totalPoints > limits.maxPoints) {
          throw new GpxError('gpx_limits_exceeded', 'too many track points');
        }
        if (isValidPoint(point)) current?.push(point as RoutePoint);
        else dropped++;
        point = null;
      } else if (name === 'trkseg' && current) {
        if (current.length > 0) segments.push({ points: current });
        current = null;
      }
      lastIndex = tagRe.lastIndex;
      continue;
    }

    if (!selfClosing) {
      stack.push(m[1]);
      depth++;
      if (depth > limits.maxDepth) throw new GpxError('gpx_limits_exceeded', 'nesting too deep');
    }

    if (name === 'gpx') sawGpxRoot = true;
    else if (name === 'trkseg') current = [];
    else if (name === 'trkpt') {
      point = {};
      const lat = attrValue(attrs, 'lat');
      const lon = attrValue(attrs, 'lon');
      const latN = lat == null ? NaN : Number(lat);
      const lonN = lon == null ? NaN : Number(lon);
      if (Number.isFinite(latN)) point.lat = latN;
      if (Number.isFinite(lonN)) point.lon = lonN;
      if (selfClosing) {
        totalPoints++;
        if (totalPoints > limits.maxPoints) {
          throw new GpxError('gpx_limits_exceeded', 'too many track points');
        }
        if (isValidPoint(point)) current?.push(point as RoutePoint);
        else dropped++;
        point = null;
      }
    } else if (!selfClosing && point) {
      openPointField(name, tagRe.lastIndex);
    }
    lastIndex = tagRe.lastIndex;
  }
  void lastIndex;

  if (!sawGpxRoot) throw new GpxError('malformed_xml', 'no gpx root element');
  if (stack.length !== 0) throw new GpxError('malformed_xml', 'unclosed elements');
  return { segments, droppedPoints: dropped };
}

function attrValue(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const m = re.exec(attrs);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? '');
}

function isValidPoint(p: Partial<RoutePoint>): p is RoutePoint {
  return (
    typeof p.lat === 'number' &&
    typeof p.lon === 'number' &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180
  );
}
