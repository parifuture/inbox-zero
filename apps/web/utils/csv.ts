/**
 * EL-375 — minimal RFC-4180 CSV helpers.
 *
 * Purposely in-tree rather than pulling a new npm dep (`csv-parse` /
 * `csv-stringify`) for a bounded feature. Handles:
 *   - Quoted fields with embedded commas, quotes (`""`), CR/LF.
 *   - Unix / Windows line endings.
 *   - Trailing newline (optional).
 *   - Empty fields vs quoted empty fields (both become `""`).
 *
 * Intentional non-goals: streaming parse, BOM handling, custom delimiters.
 * Use a real CSV lib if any of those become requirements.
 */

export function stringifyCsvRow(
  values: readonly (string | null | undefined)[],
): string {
  return values
    .map((raw) => {
      if (raw == null) return "";
      const s = String(raw);
      if (/[",\r\n]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    })
    .join(",");
}

export function stringifyCsv(
  header: readonly string[],
  rows: readonly (readonly (string | null | undefined)[])[],
): string {
  const lines: string[] = [stringifyCsvRow(header)];
  for (const row of rows) lines.push(stringifyCsvRow(row));
  return `${lines.join("\r\n")}\r\n`;
}

export class CsvParseError extends Error {
  readonly line: number;
  readonly column: number;
  constructor(message: string, line: number, column: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = "CsvParseError";
    this.line = line;
    this.column = column;
  }
}

/**
 * Parse a CSV document into a 2D string array. Preserves empty trailing rows
 * only when they contain explicit data; a pure trailing newline does not
 * emit an extra row.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let col = 1;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
          col++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
        if (ch === "\n") {
          line++;
          col = 0;
        }
      }
      col++;
      continue;
    }

    if (ch === '"') {
      if (field !== "") {
        throw new CsvParseError(
          "Unexpected quote in unquoted field",
          line,
          col,
        );
      }
      inQuotes = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\n") {
      pushField();
      pushRow();
      line++;
      col = 0;
    } else if (ch === "\r") {
      // swallow, handled by \n
    } else {
      field += ch;
    }
    col++;
  }

  if (inQuotes) {
    throw new CsvParseError("Unterminated quoted field", line, col);
  }
  // Push final field/row unless the input ended with just a trailing newline
  // (i.e. row is empty and field is empty).
  if (field !== "" || row.length > 0) {
    pushField();
    pushRow();
  }

  return rows;
}
