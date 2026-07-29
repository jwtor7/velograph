# Velograph Design System

Extracted from `velograph_cover_art.png` (1672×941). Every hex below marked **sampled** was measured directly from the artwork (median or peak-vividness pixel sampling with PIL); tokens marked _derived_ are tints/shades computed from sampled anchors for usable UI states. The cover art is the visual contract: every screen must read as the same world — a near-black night ride lit by cool gradient light.

## 1. Color palette

### Ground (sampled)

| Token                 | Hex       | Source                                             |
| --------------------- | --------- | -------------------------------------------------- |
| `--vg-bg`             | `#00030C` | page background (deep space navy-black)            |
| `--vg-bg-sidebar`     | `#010712` | app sidebar panel                                  |
| `--vg-surface`        | `#09101B` | cards, panels, chart tiles                         |
| `--vg-surface-raised` | `#0D1520` | KPI tiles, hover state                             |
| `--vg-border`         | `#1A2332` | _derived_ — hairline card borders (≈ surface +10%) |

### Brand gradient (sampled)

The logomark and highlights run a blue→teal→green sweep:

| Token              | Hex       | Source                   |
| ------------------ | --------- | ------------------------ |
| `--vg-brand-blue`  | `#00BDFE` | logo left facet          |
| `--vg-brand-teal`  | `#00FFED` | logo top facet           |
| `--vg-brand-green` | `#3BEDB9` | pill badge text/border   |
| `--vg-brand-mint`  | `#02FCD1` | headline "clear visuals" |

Brand gradient: `linear-gradient(135deg, #00BDFE, #00FFED 55%, #3BEDB9)`.
Headline/accent gradient (cyan → blue → violet): `linear-gradient(90deg, #02FCD1, #3680F6, #9B5AFF)` (all sampled).

### Accents (sampled)

| Token                     | Hex       | Source                              |
| ------------------------- | --------- | ----------------------------------- |
| `--vg-accent-blue`        | `#3680F6` | headline mid-gradient, links        |
| `--vg-accent-violet`      | `#9B5AFF` | headline "insights", AI affordances |
| `--vg-accent-violet-deep` | `#6A4EBC` | BETA badge                          |
| `--vg-progress-blue`      | `#187CF8` | confidence/progress bars            |

### Metric channel colors (sampled from the chart tiles)

Fixed, never reassigned — a metric keeps its color everywhere in the app:

| Channel    | Token               | Hex                                                          |
| ---------- | ------------------- | ------------------------------------------------------------ |
| Elevation  | `--vg-ch-elevation` | `#653ACA` (line) / `#4119A4` (fill top, fade to transparent) |
| Speed      | `--vg-ch-speed`     | `#01E289`                                                    |
| Power      | `--vg-ch-power`     | `#FBB408`                                                    |
| Heart rate | `--vg-ch-hr`        | `#ED4933`                                                    |
| Cadence    | `--vg-ch-cadence`   | `#0997F2`                                                    |

Chart fills are the channel color at ~12–18% alpha fading to 0 toward the baseline, over the tile surface.

### Heart-rate zone scale (sampled from the Performance Zones strip)

| Zone         | Hex                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------- |
| Z1 Recovery  | `#28C8EE`                                                                                   |
| Z2 Endurance | `#0ED894`                                                                                   |
| Z3 Tempo     | `#EBCB32`                                                                                   |
| Z4 Threshold | `#EE9E1D`                                                                                   |
| Z5 VO₂ Max   | `#ED3E3A`                                                                                   |
| Z6 Anaerobic | `#9B5AFF` (bar fill sampled dim at `#3C305A`; use the violet accent for the filled portion) |

### Route trace (sampled)

Route polylines are drawn as a progress gradient start→finish: `#2CE466` → `#3D61F9`, in a true interactive geographic viewport. Start is green and finish is a white ring on dark. The route-only state uses the existing dark canvas without inventing geographic context; when a validated local raster MBTiles package is configured, its tiles sit beneath the same route geometry. Map controls use text labels, the existing compact button treatment, visible focus, and 44 px touch targets on narrow screens.

### Text

| Token                 | Hex       | Source                                                                                        |
| --------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `--vg-text`           | `#FFFFFF` | sampled headline                                                                              |
| `--vg-text-secondary` | `#B8C0CC` | _derived_                                                                                     |
| `--vg-text-muted`     | `#758197` | _derived_ (4.85:1 on `#09101B`, 4.67:1 on raised `#0D1520`; sampled label grays are below AA) |

Accessibility note: sampled label grays from the art fail AA contrast at small sizes; the derived text tokens are the shippable values. Channel colors are supplemented by icons/labels (color-independent status cues, PRD §14).

## 2. Typography

- Mood: modern grotesque sans, tight tracking, confident weight contrast — big white numerals against dim labels.
- Face: **Inter** (bundled locally, never fetched remotely), fallback `-apple-system, "Segoe UI", Roboto, sans-serif`.
- Wordmark/display: heavy italic weight (logo is a bold italic sans); use Inter 800 italic for the wordmark only.
- Numbers: `font-variant-numeric: tabular-nums` on all metrics, KPIs, and axes.
- Scale: labels 11–12 px uppercase-free, medium gray; KPI values 20–28 px, weight 700, white; section titles 13–14 px weight 600; hero/display 32–48 px weight 800.
- Unit suffixes render smaller (≈60%) and muted next to the value (e.g. **102.4** km).

## 3. Spacing, shape, texture

- Base spacing unit 4 px; cards pad 16–20 px; grid gutters 12–16 px.
- Corner radius: cards/tiles 12 px; pills/badges fully rounded; buttons 8 px.
- Borders: 1 px hairline `--vg-border`; no drop shadows heavier than `0 1px 2px rgb(0 0 0 / 40%)` — depth comes from surface steps, not shadow.
- Lighting feel: cool glow accents (brand teal/blue) may halo interactive/brand elements at very low alpha; background may carry a barely-visible radial vignette toward `#00030C` edges. No noise textures in-app; keep surfaces flat and clean.
- Density: dashboard-dense but breathable — many small tiles, each with one label, one big number, one visual.

## 4. Components (as seen in the art)

- **Sidebar**: `--vg-bg-sidebar`, icon + label rows, active row gets a `--vg-surface-raised` pill with white text; inactive rows muted.
- **KPI tile**: icon in channel color, tiny muted label, large tabular numeral + small unit.
- **Pill badge**: transparent fill, 1 px `--vg-brand-green` border, brand-green text (as in "Public Source · Local-First · Runs in Your Browser").
- **Chart tile**: title left, current value right in channel color; sparkline/area chart beneath; muted axis ticks.
- **Zone strip**: six columns, zone label + time + percent, thin rounded progress bar in the zone color.
- **Route panel**: interactive geographic viewport, gradient polyline, start/finish/distance/
  direction markers, scale, compact controls, and an optional validated local basemap beneath the
  route.

## 5. Rules

1. Dark theme only for v1 — the product is the night-ride aesthetic.
2. One glow accent per view; everything else stays flat.
3. Channel colors are semantic and immutable; never use them decoratively.
4. All fonts, icons, and styles are bundled — zero remote requests at render (PRD §9.3).
5. Meet WCAG 2.2 AA: use derived text tokens, visible focus rings (`--vg-brand-teal` 2 px), and non-color status cues.
6. Confirmation dialogs move focus to Cancel, trap focus, close on Escape when idle, and restore focus to their trigger. Interactive time-series charts expose a keyboard slider cursor with fine, page, and boundary controls.
