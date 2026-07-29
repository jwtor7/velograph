/**
 * Streaming RFC 4180-style CSV parser (PRD §11.2). Handles quoted fields,
 * escaped quotes, CR/LF/CRLF line endings, and a UTF-8 BOM. Imported values
 * are always data — nothing here is ever evaluated or interpolated.
 */

export class CsvError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.name = 'CsvError';
    this.line = line;
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

  private readonly onRow: (row: string[], line: number) => void;

  constructor(onRow: (row: string[], line: number) => void) {
    this.onRow = onRow;
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
            this.field += '"';
            continue;
          }
          this.inQuotes = false;
          // fall through to normal handling of c
        } else if (c === '"') {
          this.afterQuote = true;
          continue;
        } else {
          if (c === '\n') this.line++;
          this.field += c;
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
        this.field += c;
        this.sawAny = true;
      }
    }
  }

  end(): void {
    if (this.inQuotes && !this.afterQuote) throw new CsvError('unterminated quote', this.line);
    this.endRow();
  }

  private endField(): void {
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
    this.row.push(this.field);
    this.field = '';
    const complete = this.row;
    this.row = [];
    this.sawAny = false;
    this.onRow(complete, this.line);
  }
}

/** Convenience: parse a whole CSV text into rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const p = new CsvStreamParser((row) => rows.push(row));
  p.push(text);
  p.end();
  return rows;
}
