import type { RoutePoint, RouteSegment } from '@velograph/shared';
import { parseInstant } from '@velograph/shared';
import { parseStrictNumber } from './numeric.ts';

/**
 * Secure, namespace-aware GPX parser (ROUTE-001, ROUTE-005).
 *
 * Security posture:
 *  - Any DTD/ENTITY declaration is rejected outright — external entities and
 *    entity expansion cannot occur.
 *  - XML is scanned without recovery: exact qualified close names, declared
 *    namespace prefixes, one GPX document element, and no trailing content.
 *  - Hard resource limits: input size, point count, element nesting depth.
 *  - Coordinates, timestamps, and elevations are range-validated; invalid
 *    points are dropped and counted, never guessed.
 *
 * This is a purpose-built parser for the GPX track subset (trk/trkseg/trkpt,
 * ele, time, and speed/course extensions), versioned via GPX_PARSER_VERSION so
 * files can be reprocessed after upgrades (IMP-010).
 */
export const GPX_PARSER_VERSION = 'gpx-v3';

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

export type GpxErrorCode =
  'xml_doctype_rejected' | 'gpx_limits_exceeded' | 'malformed_xml' | 'timestamps_invalid';

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

type NullableTimeRoutePoint = Omit<RoutePoint, 't'> & { t: number | null };
type PointField = 'ele' | 'time' | 'speed' | 'course';

interface XmlFrame {
  qName: string;
  local: string;
  namespaceUri: string | null;
  namespaces: Map<string, string>;
}

interface ParsedStartTag {
  frame: XmlFrame;
  attributes: Map<string, string>;
  selfClosing: boolean;
}

interface TextCapture {
  frame: XmlFrame;
  field: PointField;
  text: string;
}

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const GPX_NAMESPACES = new Set([
  'http://www.topografix.com/GPX/1/0',
  'http://www.topografix.com/GPX/1/1',
]);
const QNAME = '[A-Za-z_][\\w.-]*(?::[A-Za-z_][\\w.-]*)?';
const QNAME_AT_START = new RegExp(`^(${QNAME})`);
const CLOSE_TAG = new RegExp(`^<\\/(${QNAME})[\\u0009\\u000a\\u000d\\u0020]*>$`);
const PREDEFINED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function parseGpx(input: string, limits: GpxLimits = DEFAULT_GPX_LIMITS): GpxResult {
  validateLimits(limits);
  if (exceedsUtf8Bytes(input, limits.maxBytes)) {
    throw new GpxError('gpx_limits_exceeded', 'input exceeds size limit');
  }
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(input)) {
    throw new GpxError('xml_doctype_rejected', 'DTD and entity declarations are not allowed');
  }

  const segments: { points: NullableTimeRoutePoint[] }[] = [];
  let current: NullableTimeRoutePoint[] | null = null;
  let point:
    (Partial<Omit<NullableTimeRoutePoint, 't'>> & Pick<NullableTimeRoutePoint, 't'>) | null = null;
  let dropped = 0;
  let totalPoints = 0;
  let sawRoot = false;
  let rootClosed = false;
  let sawXmlDeclaration = false;
  let textCapture: TextCapture | null = null;
  const stack: XmlFrame[] = [];
  const baseNamespaces = new Map<string, string>([['xml', XML_NAMESPACE]]);

  const finishPoint = () => {
    if (!point) return;
    totalPoints++;
    if (totalPoints > limits.maxPoints) {
      throw new GpxError('gpx_limits_exceeded', 'too many track points');
    }
    if (isValidPoint(point)) current?.push(point);
    else dropped++;
    point = null;
  };

  const finishField = (capture: TextCapture) => {
    if (!point) return;
    const text = capture.text.trim();
    if (capture.field === 'ele') {
      const value = parseStrictNumber(text, { minExclusive: -500, maxExclusive: 10_000 });
      if (value != null) point.ele = value;
    } else if (capture.field === 'time') {
      const timestamp = parseInstant(text);
      if (timestamp == null) {
        throw new GpxError('timestamps_invalid', 'track-point timestamp invalid');
      }
      point.t = timestamp;
    } else if (capture.field === 'speed') {
      const value = parseStrictNumber(text, { min: 0, maxExclusive: 150 });
      if (value != null) point.speed = value;
    } else {
      const value = parseStrictNumber(text, { min: 0, maxExclusive: 360 });
      if (value != null) point.course = value;
    }
  };

  const openElement = (tag: ParsedStartTag) => {
    const { frame, attributes } = tag;
    if (textCapture) {
      throw new GpxError('malformed_xml', 'point field contains nested markup');
    }
    if (isGpxElement(frame, 'trkseg')) {
      if (current) throw new GpxError('malformed_xml', 'track segments may not be nested');
      current = [];
    } else if (isGpxElement(frame, 'trkpt')) {
      if (point) throw new GpxError('malformed_xml', 'track points may not be nested');
      point = { t: null };
      const lat = attributes.get('lat') ?? null;
      const lon = attributes.get('lon') ?? null;
      const latNumber = parseStrictNumber(lat, { min: -90, max: 90 });
      const lonNumber = parseStrictNumber(lon, { min: -180, max: 180 });
      if (latNumber != null) point.lat = latNumber;
      if (lonNumber != null) point.lon = lonNumber;
    } else if (point) {
      const field = pointField(frame);
      if (field) textCapture = { frame, field, text: '' };
    }
  };

  const closeElement = (frame: XmlFrame) => {
    if (textCapture?.frame === frame) {
      finishField(textCapture);
      textCapture = null;
    }
    if (isGpxElement(frame, 'trkpt')) {
      finishPoint();
    } else if (isGpxElement(frame, 'trkseg')) {
      if (current && current.length > 0) segments.push({ points: current });
      current = null;
    }
  };

  const appendCapturedText = (text: string) => {
    if (textCapture) textCapture.text += text;
  };

  const consumeText = (raw: string) => {
    if (raw.length === 0) return;
    assertXmlCharacters(raw);
    if (stack.length === 0) {
      if (!/^[\u0009\u000a\u000d\u0020]*$/u.test(raw)) {
        throw new GpxError('malformed_xml', 'content outside root element');
      }
      return;
    }
    if (raw.includes(']]>')) throw new GpxError('malformed_xml', 'invalid character data');
    const decoded = decodeXmlText(raw);
    appendCapturedText(decoded);
  };

  let cursor = input.charCodeAt(0) === 0xfeff ? 1 : 0;
  const documentStart = cursor;
  while (cursor < input.length) {
    if (input[cursor] !== '<') {
      const nextTag = input.indexOf('<', cursor);
      const end = nextTag === -1 ? input.length : nextTag;
      consumeText(input.slice(cursor, end));
      cursor = end;
      continue;
    }

    if (input.startsWith('<!--', cursor)) {
      const end = input.indexOf('-->', cursor + 4);
      if (end === -1) throw new GpxError('malformed_xml', 'unterminated comment');
      const body = input.slice(cursor + 4, end);
      if (body.includes('--') || body.endsWith('-')) {
        throw new GpxError('malformed_xml', 'invalid comment');
      }
      assertXmlCharacters(body);
      cursor = end + 3;
      continue;
    }

    if (input.startsWith('<![CDATA[', cursor)) {
      if (stack.length === 0) {
        throw new GpxError('malformed_xml', 'CDATA outside root element');
      }
      const end = input.indexOf(']]>', cursor + 9);
      if (end === -1) throw new GpxError('malformed_xml', 'unterminated CDATA');
      const body = input.slice(cursor + 9, end);
      assertXmlCharacters(body);
      appendCapturedText(body);
      cursor = end + 3;
      continue;
    }

    if (input.startsWith('<?', cursor)) {
      const end = input.indexOf('?>', cursor + 2);
      if (end === -1) {
        throw new GpxError('malformed_xml', 'unterminated processing instruction');
      }
      const body = input.slice(cursor + 2, end);
      const target = /^([A-Za-z_][\w.-]*)(?:\s|$)/.exec(body)?.[1];
      if (!target) throw new GpxError('malformed_xml', 'processing instruction is invalid');
      if (target.toLowerCase() === 'xml') {
        if (
          target !== 'xml' ||
          sawXmlDeclaration ||
          sawRoot ||
          stack.length !== 0 ||
          cursor !== documentStart
        ) {
          throw new GpxError('malformed_xml', 'XML declaration is misplaced');
        }
        sawXmlDeclaration = true;
      }
      assertXmlCharacters(body);
      cursor = end + 2;
      continue;
    }

    if (input.startsWith('</', cursor)) {
      const end = input.indexOf('>', cursor + 2);
      if (end === -1) throw new GpxError('malformed_xml', 'unterminated closing tag');
      const token = input.slice(cursor, end + 1);
      const qName = CLOSE_TAG.exec(token)?.[1];
      if (!qName) throw new GpxError('malformed_xml', 'closing tag is invalid');
      const expected = stack.at(-1);
      if (!expected) throw new GpxError('malformed_xml', 'unbalanced closing tag');
      if (expected.qName !== qName) {
        throw new GpxError('malformed_xml', 'mismatched closing tag');
      }
      closeElement(expected);
      stack.pop();
      if (stack.length === 0) rootClosed = true;
      cursor = end + 1;
      continue;
    }

    if (input.startsWith('<!', cursor)) {
      throw new GpxError('malformed_xml', 'markup declaration is not supported');
    }

    const end = findStartTagEnd(input, cursor);
    const parentNamespaces = stack.at(-1)?.namespaces ?? baseNamespaces;
    const tag = parseStartTag(input.slice(cursor, end + 1), parentNamespaces);
    if (stack.length === 0) {
      if (sawRoot || rootClosed) throw new GpxError('malformed_xml', 'multiple root elements');
      if (!isGpxElement(tag.frame, 'gpx')) {
        throw new GpxError('malformed_xml', 'document root is not GPX');
      }
      sawRoot = true;
    }
    if (stack.length + 1 > limits.maxDepth) {
      throw new GpxError('gpx_limits_exceeded', 'nesting too deep');
    }

    openElement(tag);
    if (tag.selfClosing) {
      closeElement(tag.frame);
      if (stack.length === 0) rootClosed = true;
    } else {
      stack.push(tag.frame);
    }
    cursor = end + 1;
  }

  if (!sawRoot || !rootClosed) throw new GpxError('malformed_xml', 'GPX root is incomplete');
  if (stack.length !== 0 || textCapture || point || current) {
    throw new GpxError('malformed_xml', 'unclosed elements');
  }
  // The database field is nullable and stores these explicit nulls. The shared
  // RoutePoint type is aligned separately under issue #20.
  return { segments: segments as unknown as RouteSegment[], droppedPoints: dropped };
}

function findStartTagEnd(input: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start + 1; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    } else if (char === '<') {
      throw new GpxError('malformed_xml', 'start tag is invalid');
    }
  }
  throw new GpxError('malformed_xml', 'unterminated start tag');
}

function parseStartTag(token: string, parentNamespaces: Map<string, string>): ParsedStartTag {
  const selfClosing = /\/>$/.test(token);
  const body = token.slice(1, selfClosing ? -2 : -1);
  const nameMatch = QNAME_AT_START.exec(body);
  if (!nameMatch) throw new GpxError('malformed_xml', 'start tag name is invalid');
  const qName = nameMatch[1]!;
  const remainder = body.slice(qName.length);
  if (remainder.length > 0 && !isXmlSpace(remainder[0]!)) {
    throw new GpxError('malformed_xml', 'start tag is invalid');
  }

  const { attributes, namespaces } = parseAttributes(remainder, parentNamespaces);
  const { prefix, local } = splitQName(qName);
  if (prefix === 'xmlns') throw new GpxError('malformed_xml', 'reserved prefix is invalid');
  const namespaceUri = prefix ? namespaces.get(prefix) : (namespaces.get('') ?? null);
  if (prefix && namespaceUri === undefined) {
    throw new GpxError('malformed_xml', 'namespace prefix is not declared');
  }
  validateAttributeNamespaces(attributes, namespaces);

  return {
    frame: {
      qName,
      local,
      namespaceUri: namespaceUri ?? null,
      namespaces,
    },
    attributes,
    selfClosing,
  };
}

function parseAttributes(
  source: string,
  parentNamespaces: Map<string, string>,
): { attributes: Map<string, string>; namespaces: Map<string, string> } {
  const attributes = new Map<string, string>();
  const namespaces = new Map(parentNamespaces);
  let cursor = 0;
  while (cursor < source.length) {
    const whitespaceStart = cursor;
    while (cursor < source.length && isXmlSpace(source[cursor]!)) cursor++;
    if (cursor === source.length) break;
    if (cursor === whitespaceStart) {
      throw new GpxError('malformed_xml', 'attributes must be separated');
    }

    const nameMatch = QNAME_AT_START.exec(source.slice(cursor));
    if (!nameMatch) throw new GpxError('malformed_xml', 'attribute name is invalid');
    const qName = nameMatch[1]!;
    cursor += qName.length;
    while (cursor < source.length && isXmlSpace(source[cursor]!)) cursor++;
    if (source[cursor] !== '=') {
      throw new GpxError('malformed_xml', 'attribute assignment is invalid');
    }
    cursor++;
    while (cursor < source.length && isXmlSpace(source[cursor]!)) cursor++;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") {
      throw new GpxError('malformed_xml', 'attribute value must be quoted');
    }
    const valueStart = ++cursor;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd === -1) throw new GpxError('malformed_xml', 'attribute value is unterminated');
    const rawValue = source.slice(valueStart, valueEnd);
    if (rawValue.includes('<')) {
      throw new GpxError('malformed_xml', 'attribute value is invalid');
    }
    const value = decodeXmlText(rawValue);
    if (attributes.has(qName)) throw new GpxError('malformed_xml', 'duplicate attribute');
    attributes.set(qName, value);
    applyNamespaceDeclaration(qName, value, namespaces);
    cursor = valueEnd + 1;
  }
  return { attributes, namespaces };
}

function applyNamespaceDeclaration(
  qName: string,
  value: string,
  namespaces: Map<string, string>,
): void {
  if (qName === 'xmlns') {
    if (value === XML_NAMESPACE || value === XMLNS_NAMESPACE) {
      throw new GpxError('malformed_xml', 'default namespace is reserved');
    }
    if (value === '') namespaces.delete('');
    else namespaces.set('', value);
    return;
  }
  if (!qName.startsWith('xmlns:')) return;

  const prefix = qName.slice('xmlns:'.length);
  if (
    prefix === 'xmlns' ||
    value === '' ||
    value === XMLNS_NAMESPACE ||
    (prefix === 'xml' && value !== XML_NAMESPACE) ||
    (prefix !== 'xml' && value === XML_NAMESPACE)
  ) {
    throw new GpxError('malformed_xml', 'namespace declaration is invalid');
  }
  namespaces.set(prefix, value);
}

function validateAttributeNamespaces(
  attributes: Map<string, string>,
  namespaces: Map<string, string>,
): void {
  const expandedNames = new Set<string>();
  for (const qName of attributes.keys()) {
    if (qName === 'xmlns' || qName.startsWith('xmlns:')) continue;
    const { prefix, local } = splitQName(qName);
    if (prefix === 'xmlns') throw new GpxError('malformed_xml', 'reserved prefix is invalid');
    const namespaceUri = prefix ? namespaces.get(prefix) : '';
    if (prefix && namespaceUri === undefined) {
      throw new GpxError('malformed_xml', 'attribute namespace prefix is not declared');
    }
    const expandedName = `${namespaceUri ?? ''}\u0000${local}`;
    if (expandedNames.has(expandedName)) {
      throw new GpxError('malformed_xml', 'duplicate expanded attribute');
    }
    expandedNames.add(expandedName);
  }
}

function splitQName(qName: string): { prefix: string | null; local: string } {
  const colon = qName.indexOf(':');
  return colon === -1
    ? { prefix: null, local: qName }
    : { prefix: qName.slice(0, colon), local: qName.slice(colon + 1) };
}

function isGpxElement(frame: XmlFrame, local: string): boolean {
  return (
    frame.local === local &&
    (frame.namespaceUri === null ||
      frame.namespaceUri === '' ||
      GPX_NAMESPACES.has(frame.namespaceUri))
  );
}

function pointField(frame: XmlFrame): PointField | null {
  if (isGpxElement(frame, 'ele')) return 'ele';
  if (isGpxElement(frame, 'time')) return 'time';
  if (frame.local === 'speed') return 'speed';
  if (frame.local === 'course') return 'course';
  return null;
}

function decodeXmlText(raw: string): string {
  assertXmlCharacters(raw);
  let decoded = '';
  for (let cursor = 0; cursor < raw.length;) {
    const ampersand = raw.indexOf('&', cursor);
    if (ampersand === -1) {
      decoded += raw.slice(cursor);
      break;
    }
    decoded += raw.slice(cursor, ampersand);
    const semicolon = raw.indexOf(';', ampersand + 1);
    if (semicolon === -1) throw new GpxError('malformed_xml', 'entity reference is invalid');
    const entity = raw.slice(ampersand + 1, semicolon);
    const predefined = PREDEFINED_ENTITIES[entity];
    if (predefined !== undefined) {
      decoded += predefined;
    } else {
      const codePoint = parseCharacterReference(entity);
      if (codePoint === null || !isXmlCodePoint(codePoint)) {
        throw new GpxError('malformed_xml', 'entity reference is invalid');
      }
      decoded += String.fromCodePoint(codePoint);
    }
    cursor = semicolon + 1;
  }
  assertXmlCharacters(decoded);
  return decoded;
}

function parseCharacterReference(entity: string): number | null {
  if (/^#x[0-9A-Fa-f]+$/.test(entity)) return Number.parseInt(entity.slice(2), 16);
  if (/^#[0-9]+$/.test(entity)) return Number.parseInt(entity.slice(1), 10);
  return null;
}

function validateLimits(limits: GpxLimits): void {
  if (
    !Number.isSafeInteger(limits.maxBytes) ||
    !Number.isSafeInteger(limits.maxPoints) ||
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxBytes < 0 ||
    limits.maxPoints < 0 ||
    limits.maxDepth < 0
  ) {
    throw new GpxError('gpx_limits_exceeded', 'GPX limits are invalid');
  }
}

function exceedsUtf8Bytes(value: string, maxBytes: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) bytes += 1;
    else if (codeUnit <= 0x7ff) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maxBytes) return true;
  }
  return false;
}

function isXmlSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

function assertXmlCharacters(value: string): void {
  for (const char of value) {
    const codePoint = char.codePointAt(0)!;
    if (!isXmlCodePoint(codePoint)) {
      throw new GpxError('malformed_xml', 'invalid XML character');
    }
  }
}

function isXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function isValidPoint(p: Partial<NullableTimeRoutePoint>): p is NullableTimeRoutePoint {
  return (
    typeof p.lat === 'number' &&
    typeof p.lon === 'number' &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180
  );
}
