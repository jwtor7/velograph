import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGpx, DEFAULT_GPX_LIMITS } from './gpx.ts';

const HARDENING_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'synthetic',
  'import-hardening',
);

const readGpxFixture = (name: string) => readFileSync(join(HARDENING_FIXTURES, name), 'utf8');

const wrap = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1"><trk>${body}</trk></gpx>`;

const pt = (lat: number, lon: number, ele = 10, time = '2031-04-02T07:30:00Z') =>
  `<trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele><time>${time}</time></trkpt>`;

describe('secure GPX parser (ROUTE-001/004/005)', () => {
  it('parses points with elevation and time', () => {
    const { segments } = parseGpx(
      wrap(`<trkseg>${pt(-48.5, -123.5)}${pt(-48.51, -123.51)}</trkseg>`),
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]!.points).toHaveLength(2);
    expect(segments[0]!.points[0]).toMatchObject({ lat: -48.5, lon: -123.5, ele: 10 });
    expect(segments[0]!.points[0]!.t).toBe(Date.UTC(2031, 3, 2, 7, 30, 0));
  });

  it('preserves multiple segments (gaps are not bridged)', () => {
    const gpx = wrap(`<trkseg>${pt(-48.5, -123.5)}</trkseg><trkseg>${pt(-48.6, -123.6)}</trkseg>`);
    expect(parseGpx(gpx).segments).toHaveLength(2);
  });

  it('is namespace-tolerant', () => {
    const gpx = wrap(
      '<trkseg><trkpt lat="-48.5" lon="-123.5"><g:ele>5</g:ele></trkpt></trkseg>',
    ).replace(
      'xmlns="http://www.topografix.com/GPX/1/1"',
      'xmlns="http://www.topografix.com/GPX/1/1" xmlns:g="http://www.topografix.com/GPX/1/1"',
    );
    expect(parseGpx(gpx).segments[0]!.points[0]!.ele).toBe(5);
  });

  it('matches exact qualified close names even when prefixes share a namespace', () => {
    const gpx =
      '<a:gpx xmlns:a="http://www.topografix.com/GPX/1/1" xmlns:b="http://www.topografix.com/GPX/1/1">' +
      '<a:trk><a:trkseg><a:trkpt lat="-48.5" lon="-123.5"></b:trkpt></a:trkseg></a:trk></a:gpx>';
    expect(() => parseGpx(gpx)).toThrowError(expect.objectContaining({ code: 'malformed_xml' }));
  });

  it('rejects undeclared prefixes and non-GPX root namespaces', () => {
    expect(() => parseGpx('<g:gpx/>')).toThrowError(
      expect.objectContaining({ code: 'malformed_xml' }),
    );
    expect(() => parseGpx('<g:gpx xmlns:g="urn:synthetic:not-gpx"/>')).toThrowError(
      expect.objectContaining({ code: 'malformed_xml' }),
    );
  });

  it('rejects DOCTYPE / external entity declarations', () => {
    const evil =
      '<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><gpx><trk/></gpx>';
    expect(() => parseGpx(evil)).toThrowError(
      expect.objectContaining({ code: 'xml_doctype_rejected' }),
    );
  });

  it('enforces the point-count limit', () => {
    const many = wrap(`<trkseg>${pt(-48.5, -123.5).repeat(50)}</trkseg>`);
    expect(() => parseGpx(many, { ...DEFAULT_GPX_LIMITS, maxPoints: 10 })).toThrowError(
      expect.objectContaining({ code: 'gpx_limits_exceeded' }),
    );
  });

  it('enforces the size limit', () => {
    expect(() => parseGpx(wrap(''), { ...DEFAULT_GPX_LIMITS, maxBytes: 10 })).toThrowError(
      expect.objectContaining({ code: 'gpx_limits_exceeded' }),
    );
  });

  it('enforces the nesting-depth limit', () => {
    const deep = '<a>'.repeat(40) + '</a>'.repeat(40);
    expect(() => parseGpx(`<gpx>${deep}</gpx>`)).toThrowError(
      expect.objectContaining({ code: 'gpx_limits_exceeded' }),
    );
  });

  it('drops out-of-range coordinates instead of importing them', () => {
    const gpx = wrap(`<trkseg>${pt(-48.5, -123.5)}${pt(95, -123.5)}</trkseg>`);
    const res = parseGpx(gpx);
    expect(res.segments[0]!.points).toHaveLength(1);
    expect(res.droppedPoints).toBe(1);
  });

  it('preserves a genuinely missing time as explicit null', () => {
    const gpx = readGpxFixture('Outdoor Cycling-Route-20310607_080000.gpx');
    expect(parseGpx(gpx).segments[0]!.points[0]).toMatchObject({ t: null });
  });

  it('rejects a present but malformed track-point time', () => {
    const gpx = readGpxFixture('Outdoor Cycling-Route-20310608_080000-invalid-time.gpx');
    expect(() => parseGpx(gpx)).toThrowError(
      expect.objectContaining({ code: 'timestamps_invalid' }),
    );
  });

  it('rejects mismatched, prematurely closed, and unclosed XML', () => {
    expect(() => parseGpx('<gpx><trk><same-depth></different></trk></gpx>')).toThrowError(
      expect.objectContaining({ code: 'malformed_xml' }),
    );
    expect(() => parseGpx('<gpx><trk><trkseg></gpx>')).toThrowError(
      expect.objectContaining({ code: 'malformed_xml' }),
    );
    expect(() => parseGpx('<gpx></gpx></extra>')).toThrowError(
      expect.objectContaining({ code: 'malformed_xml' }),
    );
    expect(() => parseGpx('<gpx><trk>')).toThrowError(
      expect.objectContaining({ code: 'malformed_xml' }),
    );
    expect(() => parseGpx('not xml at all')).toThrowError(
      expect.objectContaining({ code: 'malformed_xml' }),
    );
  });

  it('rejects closing-tag attributes, multiple roots, and trailing content', () => {
    expect(() => parseGpx('<gpx></gpx bogus>')).toThrowError(
      expect.objectContaining({ code: 'malformed_xml' }),
    );
    expect(() => parseGpx('<gpx/><gpx/>')).toThrowError(
      expect.objectContaining({ code: 'malformed_xml' }),
    );
    expect(() => parseGpx('<gpx/>synthetic trailing content')).toThrowError(
      expect.objectContaining({ code: 'malformed_xml' }),
    );
  });

  it('rejects undeclared entities while accepting predefined and numeric references', () => {
    const gpx = wrap(
      '<trkseg><trkpt lat="-48.5" lon="-123.5"><time>2031-04-02T07:30:00Z</time></trkpt></trkseg>',
    );
    expect(() => parseGpx(gpx.replace('creator="t"', 'creator="&custom;"'))).toThrowError(
      expect.objectContaining({ code: 'malformed_xml' }),
    );
    expect(() =>
      parseGpx(gpx.replace('creator="t"', 'creator="synthetic &amp; &#x58;1"')),
    ).not.toThrow();
  });
});
