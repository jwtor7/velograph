import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api, type BasemapResponse, type RoutePoint } from '../api.ts';
import {
  buildRouteMapModel,
  routePositionAtTime,
  type RouteMapModel,
} from '../chartspec/route-map-model.ts';

type BasemapViewState = BasemapResponse | { state: 'loading' | 'tile_error' };
type ReadyBasemap = Extract<BasemapResponse, { state: 'ready' }>;

const FALLBACK_ROUTE_START = '#2ce466';
const FALLBACK_ROUTE_END = '#3d61f9';
const MAP_MIN_ZOOM = 0;
const MAP_MAX_ZOOM = 22;

function parseHex(color: string, fallback: string): [number, number, number] {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color.trim());
  const source = match ?? /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(fallback)!;
  return [
    Number.parseInt(source[1]!, 16),
    Number.parseInt(source[2]!, 16),
    Number.parseInt(source[3]!, 16),
  ];
}

function mixColor(start: string, finish: string, progress: number): string {
  const from = parseHex(start, FALLBACK_ROUTE_START);
  const to = parseHex(finish, FALLBACK_ROUTE_END);
  const channel = (index: number) =>
    Math.round(from[index]! + (to[index]! - from[index]!) * progress)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

const latLng = (point: { lat: number; lon: number }): L.LatLngTuple => [point.lat, point.lon];

function plainTextTooltip(value: string): HTMLElement {
  const content = document.createElement('span');
  content.textContent = value;
  return content;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function fitRoute(map: L.Map, model: RouteMapModel, animate: boolean) {
  map.fitBounds(L.latLngBounds(model.bounds), {
    animate: animate && !prefersReducedMotion(),
    duration: 0.28,
    maxZoom: 17,
    padding: [30, 30],
  });
}

function validTileBounds(bounds: ReadyBasemap['bounds']): L.LatLngBounds | undefined {
  if (!bounds || bounds.length !== 4 || !bounds.every(Number.isFinite)) return undefined;
  const [west, south, east, north] = bounds;
  if (south! >= north! || west! >= east!) return undefined;
  return L.latLngBounds([south!, west!], [north!, east!]);
}

function addRouteLayers(map: L.Map, model: RouteMapModel, container: HTMLElement) {
  const renderer = L.canvas({ padding: 0.35, tolerance: 8 });
  const styles = getComputedStyle(container);
  const startColor = styles.getPropertyValue('--vg-route-start').trim() || FALLBACK_ROUTE_START;
  const finishColor = styles.getPropertyValue('--vg-route-end').trim() || FALLBACK_ROUTE_END;

  L.polyline(
    model.renderRuns.map((run) => run.map(latLng)),
    {
      color: mixColor(startColor, finishColor, 0.5),
      weight: 4,
      opacity: 0.82,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false,
      renderer,
    },
  ).addTo(map);

  for (const chunk of model.gradientChunks) {
    L.polyline(chunk.points.map(latLng), {
      color: mixColor(startColor, finishColor, chunk.progress),
      weight: 4,
      opacity: 0.92,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false,
      renderer,
    }).addTo(map);
  }

  const start = L.circleMarker(latLng(model.start.position), {
    radius: 6,
    color: '#00030c',
    weight: 2,
    fillColor: startColor,
    fillOpacity: 1,
    interactive: false,
    renderer,
  }).addTo(map);
  start.bindTooltip(plainTextTooltip(model.start.label), {
    permanent: true,
    direction: 'top',
    className: 'route-map-label route-map-label-endpoint',
    offset: [0, -7],
  });

  const finish = L.circleMarker(latLng(model.finish.position), {
    radius: 7,
    color: '#ffffff',
    weight: 2,
    fillColor: finishColor,
    fillOpacity: 0.25,
    interactive: false,
    renderer,
  }).addTo(map);
  finish.bindTooltip(plainTextTooltip(model.finish.label), {
    permanent: true,
    direction: 'bottom',
    className: 'route-map-label route-map-label-endpoint',
    offset: [0, 7],
  });

  for (const marker of model.distanceMarkers) {
    const layer = L.circleMarker(latLng(marker.position), {
      radius: 3,
      color: '#ffffff',
      weight: 1.4,
      fillColor: '#00030c',
      fillOpacity: 0.9,
      interactive: false,
      renderer,
    }).addTo(map);
    layer.bindTooltip(plainTextTooltip(marker.label), {
      permanent: true,
      direction: 'right',
      className: 'route-map-label',
      offset: [5, 0],
    });
  }

  for (const marker of model.directionMarkers) {
    const layer = L.circleMarker(latLng(marker.position), {
      radius: 2.5,
      color: '#00ffed',
      weight: 1.5,
      fillColor: '#00030c',
      fillOpacity: 1,
      interactive: false,
      renderer,
    }).addTo(map);
    layer.bindTooltip(plainTextTooltip(marker.label), {
      permanent: true,
      direction: 'left',
      className: 'route-map-label route-map-label-direction',
      offset: [-4, 0],
    });
  }

  return renderer;
}

export function InteractiveRouteMap({
  segments,
  cursorT,
  height = 360,
}: {
  segments: { points: RoutePoint[] }[];
  cursorT: number | null;
  height?: number;
}) {
  const mapId = `route-map-${useId().replaceAll(':', '')}`;
  const helpId = `${mapId}-help`;
  const summaryId = `${mapId}-summary`;
  const model = useMemo(() => buildRouteMapModel(segments), [segments]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const cursorRef = useRef<L.CircleMarker | null>(null);
  const cursorRendererRef = useRef<L.Renderer | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const [basemap, setBasemap] = useState<BasemapViewState>({ state: 'loading' });

  useEffect(() => {
    let active = true;
    void api
      .basemap()
      .then((response) => {
        if (active) setBasemap(response);
      })
      .catch(() => {
        if (active) setBasemap({ state: 'invalid' });
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !model) return;

    const reduceMotion = prefersReducedMotion();
    const map = L.map(container, {
      attributionControl: false,
      boxZoom: true,
      doubleClickZoom: true,
      dragging: true,
      fadeAnimation: !reduceMotion,
      inertia: !reduceMotion,
      keyboard: true,
      keyboardPanDelta: 72,
      markerZoomAnimation: !reduceMotion,
      maxZoom: MAP_MAX_ZOOM,
      minZoom: MAP_MIN_ZOOM,
      preferCanvas: true,
      scrollWheelZoom: true,
      touchZoom: true,
      zoomAnimation: !reduceMotion,
      zoomControl: false,
    });
    mapRef.current = map;
    cursorRendererRef.current = addRouteLayers(map, model, container);
    L.control
      .scale({ imperial: false, metric: true, maxWidth: 120, position: 'bottomleft' })
      .addTo(map);
    fitRoute(map, model, false);

    return () => {
      cursorRef.current = null;
      cursorRendererRef.current = null;
      tileLayerRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, [model]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !model) return;
    if (tileLayerRef.current) {
      tileLayerRef.current.removeFrom(map);
      tileLayerRef.current = null;
    }
    if (basemap.state !== 'ready') return;

    const minZoom = Number.isInteger(basemap.minZoom) ? basemap.minZoom : 0;
    const maxZoom = Number.isInteger(basemap.maxZoom) ? basemap.maxZoom : 18;
    const layer = L.tileLayer('/api/basemap/tiles/{z}/{x}/{y}', {
      bounds: validTileBounds(basemap.bounds),
      keepBuffer: 2,
      maxNativeZoom: maxZoom,
      maxZoom: MAP_MAX_ZOOM,
      minNativeZoom: minZoom,
      // Below the package's native floor the route remains interactive, but
      // the tile layer stays idle instead of enumerating a high-zoom world.
      minZoom,
      noWrap: false,
      opacity: 0.72,
      tileSize: 256,
      updateWhenIdle: true,
      zIndex: 0,
    });
    let active = true;
    const handleTileError = () => {
      if (active) setBasemap({ state: 'tile_error' });
    };
    layer.once('tileerror', handleTileError);
    layer.addTo(map);
    layer.bringToBack();
    tileLayerRef.current = layer;
    return () => {
      active = false;
      layer.off('tileerror', handleTileError);
      layer.removeFrom(map);
      if (tileLayerRef.current === layer) tileLayerRef.current = null;
    };
  }, [basemap, model]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !model) return;
    const position = cursorT == null ? null : routePositionAtTime(model, cursorT);
    if (!position) {
      if (cursorRef.current) {
        cursorRef.current.removeFrom(map);
        cursorRef.current = null;
      }
      return;
    }
    if (cursorRef.current) {
      cursorRef.current.setLatLng(latLng(position));
      return;
    }
    cursorRef.current = L.circleMarker(latLng(position), {
      radius: 8,
      color: '#00ffed',
      weight: 2,
      fillColor: '#00030c',
      fillOpacity: 0.25,
      interactive: false,
      renderer: cursorRendererRef.current ?? undefined,
    }).addTo(map);
  }, [cursorT, model]);

  const zoomBy = useCallback((delta: number) => {
    mapRef.current?.setZoom(mapRef.current.getZoom() + delta, {
      animate: !prefersReducedMotion(),
    });
  }, []);

  const resetView = useCallback(() => {
    if (mapRef.current && model) fitRoute(mapRef.current, model, true);
  }, [model]);

  if (!model) {
    return <p className="muted route-map-empty">No route recorded for this ride.</p>;
  }

  const basemapStatus =
    basemap.state === 'loading'
      ? 'Checking local basemap…'
      : basemap.state === 'ready'
        ? `Local basemap${basemap.name ? ` · ${basemap.name}` : ''}`
        : basemap.state === 'tile_error'
          ? 'Local basemap tile unavailable · showing route-only view'
          : basemap.state === 'invalid'
            ? 'Local basemap invalid · showing route-only view'
            : 'No local basemap configured · showing route-only view';
  const distanceSummary =
    model.totalDistanceM >= 1_000
      ? `${(model.totalDistanceM / 1_000).toFixed(1)} kilometres`
      : `${Math.round(model.totalDistanceM)} metres`;
  const distanceMarkerSummary = model.distanceMarkers.map((marker) => marker.label).join(', ');
  const directionMarkerSummary = model.directionMarkers.map((marker) => marker.label).join(', ');

  return (
    <div className="route-map-shell">
      <div className="route-map-toolbar" role="group" aria-label="Map controls">
        <div className="route-map-buttons">
          <button
            type="button"
            className="route-map-button"
            aria-controls={mapId}
            onClick={() => zoomBy(1)}
          >
            Zoom in
          </button>
          <button
            type="button"
            className="route-map-button"
            aria-controls={mapId}
            onClick={() => zoomBy(-1)}
          >
            Zoom out
          </button>
          <button
            type="button"
            className="route-map-button"
            aria-controls={mapId}
            onClick={resetView}
          >
            Fit route
          </button>
        </div>
        <span
          className={`route-map-status route-map-status-${basemap.state}`}
          role="status"
          aria-live="polite"
        >
          {basemapStatus}
        </span>
      </div>
      <div
        id={mapId}
        ref={containerRef}
        className="route-map"
        style={{ height }}
        role="region"
        aria-label="Interactive offline ride map"
        aria-describedby={`${helpId} ${summaryId}`}
        tabIndex={0}
      />
      <p id={summaryId} className="visually-hidden">
        Recorded route, {distanceSummary}, from Start to Finish.
        {model.recordingGapCount > 0
          ? ` ${model.recordingGapCount} recording ${model.recordingGapCount === 1 ? 'gap is' : 'gaps are'} preserved.`
          : ''}
        {distanceMarkerSummary ? ` Distance markers: ${distanceMarkerSummary}.` : ''}
        {directionMarkerSummary ? ` Direction markers: ${directionMarkerSummary}.` : ''} The scale
        updates with zoom.
      </p>
      <p id={helpId} className="route-map-help">
        Drag or pinch to move the map. With the map focused, use arrow keys to pan and plus or minus
        to zoom.
        {model.simplified
          ? ` Display geometry is simplified to ${model.renderPointCount.toLocaleString()} points; markers use the full route.`
          : ''}
        {basemap.state === 'not_configured'
          ? ' Add basemap.mbtiles to the Velograph data directory for offline streets and labels.'
          : ''}
        {basemap.state === 'ready' && basemap.attribution ? ` ${basemap.attribution}` : ''}
      </p>
    </div>
  );
}
