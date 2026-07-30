import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./theme.css', import.meta.url)), 'utf8');

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css);
  if (!match?.[1]) throw new Error(`missing_color_token_${name}`);
  return match[1];
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(foreground: string, background: string): number {
  const left = luminance(foreground);
  const right = luminance(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

describe('WCAG 2.2 AA theme contract', () => {
  it.each([
    ['vg-text', 'vg-bg'],
    ['vg-text', 'vg-surface'],
    ['vg-text-secondary', 'vg-surface'],
    ['vg-text-muted', 'vg-surface'],
    ['vg-accent-blue', 'vg-surface'],
    ['vg-accent-violet', 'vg-surface'],
    ['vg-ch-elevation', 'vg-surface'],
    ['vg-ch-speed', 'vg-surface'],
    ['vg-ch-power', 'vg-surface'],
    ['vg-ch-hr', 'vg-surface'],
    ['vg-ch-cadence', 'vg-surface'],
  ])('%s clears normal-text contrast against %s', (foreground, background) => {
    expect(contrast(token(foreground), token(background))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps a visible keyboard focus indicator independent of color alone', () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px\s+solid/);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline-offset:\s*2px/);
  });
});
