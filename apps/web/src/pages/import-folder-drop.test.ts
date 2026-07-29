import { describe, expect, it } from 'vitest';
import { resolveDroppedFolderPath, type DroppedFolderFile } from './import-folder-drop.ts';

function droppedFile(
  name: string,
  relativePath: string,
  runtimePath?: string,
  virtualFullPath?: string,
): DroppedFolderFile {
  const file = new File(['invented'], name);
  if (runtimePath !== undefined) {
    Object.defineProperty(file, 'path', { value: runtimePath });
  }
  if (virtualFullPath !== undefined) {
    Object.defineProperty(file, 'fullPath', { value: virtualFullPath });
  }
  return { file, relativePath };
}

describe('resolveDroppedFolderPath', () => {
  it('derives one absolute root only from exact relative suffixes', () => {
    expect(
      resolveDroppedFolderPath([
        droppedFile(
          'synthetic-a.csv',
          'synthetic-a.csv',
          '/synthetic/Health Export/synthetic-a.csv',
        ),
        droppedFile(
          'synthetic-b.gpx',
          'nested/synthetic-b.gpx',
          '/synthetic/Health Export/nested/synthetic-b.gpx',
        ),
      ]),
    ).toBe('/synthetic/Health Export');
  });

  it('ignores a virtual fullPath when no runtime absolute path exists', () => {
    expect(
      resolveDroppedFolderPath([
        droppedFile('synthetic.csv', 'synthetic.csv', undefined, '/virtual/synthetic.csv'),
      ]),
    ).toBeNull();
  });

  it('fails closed when files resolve to mixed roots', () => {
    expect(
      resolveDroppedFolderPath([
        droppedFile('synthetic-a.csv', 'synthetic-a.csv', '/synthetic/one/synthetic-a.csv'),
        droppedFile('synthetic-b.gpx', 'synthetic-b.gpx', '/synthetic/two/synthetic-b.gpx'),
      ]),
    ).toBeNull();
  });

  it('fails closed when File.path is absent, relative, or not an exact suffix', () => {
    expect(resolveDroppedFolderPath([droppedFile('synthetic.csv', 'synthetic.csv')])).toBeNull();
    expect(
      resolveDroppedFolderPath([
        droppedFile('synthetic.csv', 'synthetic.csv', 'relative/synthetic.csv'),
      ]),
    ).toBeNull();
    expect(
      resolveDroppedFolderPath([
        droppedFile('synthetic.csv', 'nested/synthetic.csv', '/synthetic/synthetic.csv'),
      ]),
    ).toBeNull();
  });
});
