/**
 * Streaming RFC 4180-style CSV parser (PRD §11.2). Handles quoted fields,
 * escaped quotes, CR/LF/CRLF line endings, and a UTF-8 BOM. Imported values
 * are always data — nothing here is ever evaluated or interpolated.
 */

export type CsvErrorCode = 'malformed_csv' | 'csv_limits_exceeded';

export interface CsvLimits {
  maxBytes: number;
  /** Header plus data rows. */
  maxRows: number;
  maxColumns: number;
  maxFieldChars: number;
}

export const DEFAULT_CSV_LIMITS: Readonly<CsvLimits> = {
  maxBytes: 32 * 1024 * 1024,
  maxRows: 500_001,
  maxColumns: 64,
  maxFieldChars: 64 * 1024,
};

export class CsvError extends Error {
  readonly line: number;
  readonly code: CsvErrorCode;

  constructor(message: string, line: number, code: CsvErrorCode = 'malformed_csv') {
    super(message);
    this.name = 'CsvError';
    this.line = line;
    this.code = code;
  }
}

/** Incremental parser: feed chunks, receive complete rows via callback. */
export class CsvStreamParser {
  private field = '';
  private row: string[] = [];
  private inQuotes = false;
  private afterQuote = false;
  private sawAny = false;
  private line = 1;
  private first = true;
  private emittedRows = 0;

  private readonly onRow: (row: string[], line: number) => void;
  private readonly limits: CsvLimits;

  constructor(
    onRow: (row: string[], line: number) => void,
    limits: CsvLimits = DEFAULT_CSV_LIMITS,
  ) {
    validateCsvLimits(limits);
    this.onRow = onRow;
    this.limits = limits;
  }

  push(chunk: string): void {
    let s = chunk;
    if (this.first) {
      if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
      this.first = false;
    }
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (this.inQuotes) {
        if (this.afterQuote) {
          this.afterQuote = false;
          if (c === '"') {
            this.appendField('"');
            continue;
          }
          this.inQuotes = false;
          // fall through to normal handling of c
        } else if (c === '"') {
          this.afterQuote = true;
          continue;
        } else {
          if (c === '\n') this.line++;
          this.appendField(c);
          continue;
        }
      }
      if (c === '"') {
        if (this.field !== '') throw new CsvError('quote inside unquoted field', this.line);
        this.inQuotes = true;
        this.sawAny = true;
      } else if (c === ',') {
        this.endField();
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        this.endRow();
        this.line++;
      } else {
        this.appendField(c);
        this.sawAny = true;
      }
    }
  }

  end(): void {
    if (this.inQuotes && !this.afterQuote) throw new CsvError('unterminated quote', this.line);
    this.endRow();
  }

  private endField(): void {
    if (this.row.length >= this.limits.maxColumns) {
      throw new CsvError('too many columns', this.line, 'csv_limits_exceeded');
    }
    this.row.push(this.field);
    this.field = '';
    this.sawAny = true;
    this.afterQuote = false;
    this.inQuotes = false;
  }

  private endRow(): void {
    this.afterQuote = false;
    this.inQuotes = false;
    if (!this.sawAny && this.row.length === 0) return; // blank line
    if (this.row.length >= this.limits.maxColumns) {
      throw new CsvError('too many columns', this.line, 'csv_limits_exceeded');
    }
    this.row.push(this.field);
    this.field = '';
    const complete = this.row;
    this.row = [];
    this.sawAny = false;
    this.emittedRows++;
    if (this.emittedRows > this.limits.maxRows) {
      throw new CsvError('too many rows', this.line, 'csv_limits_exceeded');
    }
    this.onRow(complete, this.line);
  }

  private appendField(value: string): void {
    if (this.field.length >= this.limits.maxFieldChars) {
      throw new CsvError('field too large', this.line, 'csv_limits_exceeded');
    }
    this.field += value;
  }
}

/** Convenience: parse a whole CSV text into rows. */
export function parseCsv(text: string, limits: CsvLimits = DEFAULT_CSV_LIMITS): string[][] {
  assertCsvByteLength(new TextEncoder().encode(text).byteLength, limits.maxBytes);
  const rows: string[][] = [];
  const p = new CsvStreamParser((row) => rows.push(row), limits);
  p.push(text);
  p.end();
  return rows;
}

export function assertCsvByteLength(
  byteLength: number,
  maxBytes = DEFAULT_CSV_LIMITS.maxBytes,
): void {
  if (
    !Number.isSafeInteger(byteLength) ||
    !Number.isSafeInteger(maxBytes) ||
    byteLength < 0 ||
    maxBytes < 0 ||
    byteLength > maxBytes
  ) {
    throw new CsvError('input exceeds size limit', 1, 'csv_limits_exceeded');
  }
}

function validateCsvLimits(limits: CsvLimits): void {
  for (const value of [limits.maxBytes, limits.maxRows, limits.maxColumns, limits.maxFieldChars]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new CsvError('CSV limit is invalid', 1, 'csv_limits_exceeded');
    }
  }
}
