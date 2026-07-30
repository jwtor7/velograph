// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type BasemapResponse, type RoutePoint } from '../api.ts';
import { InteractiveRouteMap } from './interactive-route-map.tsx';

type MockFunction = ReturnType<typeof vi.fn>;

interface MockMapRecord {
  options: Record<string, unknown>;
  fitBounds: MockFunction;
  getZoom: MockFunction;
  remove: MockFunction;
  setZoom: MockFunction;
}

interface MockLayer {
  addTo: MockFunction;
  bindTooltip: MockFunction;
  removeFrom: MockFunction;
  setLatLng: MockFunction;
}

interface MockPolylineRecord {
  latLngs: unknown;
  options: Record<string, unknown>;
  layer: MockLayer;
}

interface MockCircleMarkerRecord {
  latLng: unknown;
  options: Record<string, unknown>;
  layer: MockLayer;
}

interface MockTileLayerRecord {
  url: string;
  options: Record<string, unknown>;
  handlers: Record<string, (() => void) | undefined>;
  addTo: MockFunction;
  bringToBack: MockFunction;
  off: MockFunction;
  once: MockFunction;
  removeFrom: MockFunction;
}

const leafletMock = vi.hoisted(() => {
  const maps: MockMapRecord[] = [];
  const polylines: MockPolylineRecord[] = [];
  const circleMarkers: MockCircleMarkerRecord[] = [];
  const tileLayers: MockTileLayerRecord[] = [];
  const scaleControls: { options: Record<string, unknown>; addTo: MockFunction }[] = [];

  const createLayer = (): MockLayer => {
    const layer: MockLayer = {
      addTo: vi.fn(),
      bindTooltip: vi.fn(),
      removeFrom: vi.fn(),
      setLatLng: vi.fn(),
    };
    layer.addTo.mockImplementation(() => layer);
    layer.bindTooltip.mockImplementation(() => layer);
    layer.removeFrom.mockImplementation(() => layer);
    layer.setLatLng.mockImplementation(() => layer);
    return layer;
  };

  return {
    maps,
    polylines,
    circleMarkers,
    tileLayers,
    scaleControls,
    createLayer,
    reset() {
      maps.length = 0;
      polylines.length = 0;
      circleMarkers.length = 0;
      tileLayers.length = 0;
      scaleControls.length = 0;
    },
  };
});

vi.mock('leaflet', () => ({
  canvas: vi.fn(() => ({ kind: 'canvas-renderer' })),
  circleMarker: vi.fn((latLng: unknown, options: Record<string, unknown>) => {
    const layer = leafletMock.createLayer();
    leafletMock.circleMarkers.push({ latLng, options, layer });
    return layer;
  }),
  control: {
    scale: vi.fn((options: Record<string, unknown>) => {
      const control = {
        options,
        addTo: vi.fn(),
      };
      control.addTo.mockImplementation(() => control);
      leafletMock.scaleControls.push(control);
      return control;
    }),
  },
  latLngBounds: vi.fn((...bounds: unknown[]) => ({ bounds })),
  map: vi.fn((_container: HTMLElement, options: Record<string, unknown>) => {
    let zoom = 10;
    const record: MockMapRecord = {
      options,
      fitBounds: vi.fn(),
      getZoom: vi.fn(() => zoom),
      remove: vi.fn(),
      setZoom: vi.fn((nextZoom: number) => {
        zoom = nextZoom;
      }),
    };
    leafletMock.maps.push(record);
    return record;
  }),
  polyline: vi.fn((latLngs: unknown, options: Record<string, unknown>) => {
    const layer = leafletMock.createLayer();
    leafletMock.polylines.push({ latLngs, options, layer });
    return layer;
  }),
  tileLayer: vi.fn((url: string, options: Record<string, unknown>) => {
    const handlers: Record<string, (() => void) | undefined> = {};
    const layer: MockTileLayerRecord = {
      url,
      options,
      handlers,
      addTo: vi.fn(),
      bringToBack: vi.fn(),
      off: vi.fn((event: string, handler: () => void) => {
        if (handlers[event] === handler) delete handlers[event];
      }),
      once: vi.fn((event: string, handler: () => void) => {
        handlers[event] = handler;
      }),
      removeFrom: vi.fn(),
    };
    layer.addTo.mockImplementation(() => layer);
    layer.bringToBack.mockImplementation(() => layer);
    layer.removeFrom.mockImplementation(() => layer);
    leafletMock.tileLayers.push(layer);
    return layer;
  }),
}));

const syntheticSegments: { points: RoutePoint[] }[] = [
  {
    points: [
      { t: 0, lat: -48, lon: -123 },
      { t: 10_000, lat: -47.99, lon: -122.99 },
    ],
  },
  {
    points: [
      { t: 20_000, lat: -47.9, lon: -122.8 },
      { t: 30_000, lat: -47.89, lon: -122.79 },
    ],
  },
];

const readyBasemap: Extract<BasemapResponse, { state: 'ready' }> = {
  state: 'ready',
  format: 'raster-mbtiles',
  name: 'Synthetic QA grid',
  attribution: 'Invented test map',
  minZoom: 2,
  maxZoom: 14,
  bounds: [-124, -49, -122, -47],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  leafletMock.reset();
});

describe('InteractiveRouteMap', () => {
  it('exposes a focusable map, accessible controls, keyboard navigation, and preserved route gaps', async () => {
    vi.spyOn(api, 'basemap').mockResolvedValue({ state: 'not_configured' });
    render(<InteractiveRouteMap segments={syntheticSegments} cursorT={null} />);

    const region = screen.getByRole('region', { name: 'Interactive offline ride map' });
    const controls = screen.getByRole('group', { name: 'Map controls' });
    expect(controls).toBeTruthy();
    expect(region.tabIndex).toBe(0);
    region.focus();
    expect(document.activeElement).toBe(region);

    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' });
    const fit = screen.getByRole('button', { name: 'Fit route' });
    expect(zoomIn.getAttribute('aria-controls')).toBe(region.id);
    expect(zoomOut.getAttribute('aria-controls')).toBe(region.id);
    expect(fit.getAttribute('aria-controls')).toBe(region.id);

    const map = leafletMock.maps[0]!;
    expect(map.options).toEqual(
      expect.objectContaining({
        keyboard: true,
        keyboardPanDelta: 72,
        zoomControl: false,
      }),
    );

    fireEvent.click(zoomIn);
    fireEvent.click(zoomOut);
    expect(map.setZoom.mock.calls.map((call) => call[0])).toEqual([11, 10]);

    const initialFitCount = map.fitBounds.mock.calls.length;
    fireEvent.click(fit);
    expect(map.fitBounds).toHaveBeenCalledTimes(initialFitCount + 1);
    expect(map.fitBounds.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        maxZoom: 17,
        padding: [30, 30],
      }),
    );

    expect(leafletMock.polylines[0]?.latLngs).toEqual([
      [
        [-48, -123],
        [-47.99, -122.99],
      ],
      [
        [-47.9, -122.8],
        [-47.89, -122.79],
      ],
    ]);
    expect(screen.getByText(/1 recording gap is preserved/)).toBeTruthy();
    expect(
      await screen.findByText('No local basemap configured · showing route-only view'),
    ).toBeTruthy();
    expect(leafletMock.tileLayers).toHaveLength(0);
    expect(leafletMock.polylines.length).toBeGreaterThan(0);
  });

  it('uses only the same-origin relative tile route for a ready local basemap', async () => {
    vi.spyOn(api, 'basemap').mockResolvedValue(readyBasemap);
    render(<InteractiveRouteMap segments={syntheticSegments} cursorT={null} />);

    expect(await screen.findByText('Local basemap · Synthetic QA grid')).toBeTruthy();
    await waitFor(() => {
      expect(leafletMock.tileLayers).toHaveLength(1);
    });

    const tileLayer = leafletMock.tileLayers[0]!;
    expect(tileLayer.url).toBe('/api/basemap/tiles/{z}/{x}/{y}');
    expect(tileLayer.url).not.toMatch(/^(?:https?:)?\/\//i);
    expect(leafletMock.tileLayers.every(({ url }) => url.startsWith('/'))).toBe(true);
    expect(tileLayer.options).toEqual(
      expect.objectContaining({
        maxNativeZoom: 14,
        minNativeZoom: 2,
        minZoom: 2,
      }),
    );
    expect(tileLayer.addTo).toHaveBeenCalledWith(leafletMock.maps[0]);
    expect(tileLayer.bringToBack).toHaveBeenCalledOnce();
    expect(screen.getByText(/Invented test map/)).toBeTruthy();
  });

  it.each([
    {
      label: 'an invalid manifest',
      configure: () => vi.spyOn(api, 'basemap').mockResolvedValue({ state: 'invalid' }),
    },
    {
      label: 'a failed manifest request',
      configure: () =>
        vi.spyOn(api, 'basemap').mockRejectedValue(new Error('synthetic manifest failure')),
    },
  ])('keeps the route-only map usable after $label', async ({ configure }) => {
    configure();
    render(<InteractiveRouteMap segments={syntheticSegments} cursorT={null} />);

    expect(await screen.findByText('Local basemap invalid · showing route-only view')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Interactive offline ride map' }).tabIndex).toBe(0);
    expect(leafletMock.tileLayers).toHaveLength(0);
    expect(leafletMock.polylines.length).toBeGreaterThan(0);
  });

  it('removes a failed local tile layer while preserving the interactive route', async () => {
    vi.spyOn(api, 'basemap').mockResolvedValue(readyBasemap);
    render(<InteractiveRouteMap segments={syntheticSegments} cursorT={null} />);
    await screen.findByText('Local basemap · Synthetic QA grid');
    await waitFor(() => {
      expect(leafletMock.tileLayers).toHaveLength(1);
    });

    const tileLayer = leafletMock.tileLayers[0]!;
    act(() => {
      tileLayer.handlers['tileerror']?.();
    });

    expect(
      await screen.findByText('Local basemap tile unavailable · showing route-only view'),
    ).toBeTruthy();
    expect(tileLayer.removeFrom).toHaveBeenCalledWith(leafletMock.maps[0]);
    expect(leafletMock.polylines.length).toBeGreaterThan(0);
    expect(leafletMock.maps[0]?.remove).not.toHaveBeenCalled();
  });

  it('moves one cursor marker with the chart time and removes it when the cursor clears', async () => {
    vi.spyOn(api, 'basemap').mockResolvedValue({ state: 'not_configured' });
    const view = render(<InteractiveRouteMap segments={syntheticSegments} cursorT={0} />);

    await waitFor(() => {
      expect(leafletMock.circleMarkers.find(({ options }) => options['radius'] === 8)).toBeTruthy();
    });
    const cursor = leafletMock.circleMarkers.find(({ options }) => options['radius'] === 8)!;
    expect(cursor.latLng).toEqual([-48, -123]);

    view.rerender(<InteractiveRouteMap segments={syntheticSegments} cursorT={9_999_999} />);
    expect(cursor.layer.setLatLng).toHaveBeenLastCalledWith([-47.89, -122.79]);
    expect(leafletMock.circleMarkers.filter(({ options }) => options['radius'] === 8)).toHaveLength(
      1,
    );

    view.rerender(<InteractiveRouteMap segments={syntheticSegments} cursorT={null} />);
    expect(cursor.layer.removeFrom).toHaveBeenCalledWith(leafletMock.maps[0]);
  });
});
