import { sha256Hex } from '@velograph/shared';
import { parseHaeFilename } from './adapters.ts';

/**
 * Pre-import inventory (journey 7.2): classify candidate files without
 * changing anything. Names and hashes only — no sample values.
 */
export interface InventoryItem {
  name: string;
  sha256: string;
  sizeBytes: number;
  classification: 'recognized' | 'unsupported' | 'duplicate_in_selection';
  detectedType: string | null;
}

export function inventoryFiles(files: { name: string; data: Uint8Array }[]): InventoryItem[] {
  const seen = new Set<string>();
  return files.map((f) => {
    const hash = sha256Hex(f.data);
    const info = parseHaeFilename(f.name);
    const ext = f.name.toLowerCase().endsWith('.gpx') ? 'gpx' : 'csv';
    let classification: InventoryItem['classification'];
    if (seen.has(hash)) classification = 'duplicate_in_selection';
    else if (info || f.name.toLowerCase().endsWith('.gpx')) classification = 'recognized';
    else classification = 'unsupported';
    seen.add(hash);
    return {
      name: f.name,
      sha256: hash,
      sizeBytes: f.data.length,
      classification,
      detectedType: info ? `${info.workoutType}:${info.label}:${ext}` : null,
    };
  });
}
