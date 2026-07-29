// @vitest-environment happy-dom

import { fireEvent, render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BarChart, TimeSeriesChart } from './charts.tsx';

describe('BarChart nullable values', () => {
  it('renders unavailable values as n/a markers and keeps real zero as a measured bar', () => {
    const html = renderToStaticMarkup(
      <BarChart
        items={[
          { label: '03-01', value: 0 },
          { label: '03-02', value: null },
          { label: '03-03', value: 12 },
        ]}
        color="green"
        format={(value) => `${value.toFixed(1)} units`}
      />,
    );

    expect(html).toContain('03-01: 0.0 units');
    expect(html).toContain('03-02: Unavailable');
    expect(html).toContain('n/a');
    expect(html.match(/<rect/g) ?? []).toHaveLength(2);
    expect(html.match(/stroke-dasharray="3 3"/g) ?? []).toHaveLength(1);
  });
});

describe('TimeSeriesChart keyboard cursor', () => {
  it('exposes slider semantics and deterministic fine, page, bound, and clear controls', () => {
    const onCursor = vi.fn();
    const props = {
      title: 'Synthetic speed',
      points: [
        { t: 1_000, v: 4 },
        { t: 11_000, v: 6 },
      ],
      color: 'green',
      unit: 'm/s',
      format: (value: number) => value.toFixed(1),
      tMin: 1_000,
      tMax: 11_000,
      cursorT: null,
      onCursor,
    };
    const view = render(<TimeSeriesChart {...props} />);
    const slider = view.getByRole('slider', { name: 'Synthetic speed time cursor' });

    slider.focus();
    expect(onCursor).toHaveBeenLastCalledWith(1_000);
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onCursor).toHaveBeenLastCalledWith(1_100);
    fireEvent.keyDown(slider, { key: 'PageUp' });
    expect(onCursor).toHaveBeenLastCalledWith(2_000);
    fireEvent.keyDown(slider, { key: 'End' });
    expect(onCursor).toHaveBeenLastCalledWith(11_000);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(onCursor).toHaveBeenLastCalledWith(1_000);
    fireEvent.keyDown(slider, { key: 'Escape' });
    expect(onCursor).toHaveBeenLastCalledWith(null);

    view.rerender(<TimeSeriesChart {...props} cursorT={6_000} />);
    expect(slider.getAttribute('aria-valuenow')).toBe('6000');
    expect(slider.getAttribute('aria-valuetext')).toContain('5 seconds into ride');
  });
});
