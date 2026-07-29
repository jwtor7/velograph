import { sha256Hex } from '@velograph/shared';
import { classifyImportFileName } from './adapters.ts';

/**
 * Pre-import inventory (journey 7.2): classify candidate files without
 * changing anything. Names and hashes only — no sample values.
 */
export interface InventoryItem {
  name: string;
  sha256: string;
  sizeBytes: number;
  classification:
    | 'recognized'
    | 'unsupported'
    | 'duplicate_in_selection'
    | 'unmodelled_metric'
    | 'non_cycling_workout';
  detectedType: string | null;
}

export function inventoryFiles(files: { name: string; data: Uint8Array }[]): InventoryItem[] {
  const seen = new Set<string>();
  return files.map((f) => {
    const hash = sha256Hex(f.data);
    const candidate = classifyImportFileName(f.name);
    let classification: InventoryItem['classification'];
    if (seen.has(hash)) classification = 'duplicate_in_selection';
    else if (candidate.kind === 'supported' || candidate.kind === 'archive') {
      classification = 'recognized';
    } else if (candidate.kind === 'unmodelled_metric' || candidate.kind === 'non_cycling_workout') {
      classification = candidate.kind;
    } else {
      classification = 'unsupported';
    }
    seen.add(hash);
    return {
      name: f.name,
      sha256: hash,
      sizeBytes: f.data.length,
      classification,
      detectedType: candidate.detectedType,
    };
  });
}
