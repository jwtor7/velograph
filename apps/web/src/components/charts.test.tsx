import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BarChart } from './charts.tsx';

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
