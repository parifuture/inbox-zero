import { describe, expect, it } from "vitest";
import { CsvParseError, parseCsv, stringifyCsv, stringifyCsvRow } from "./csv";

describe("stringifyCsvRow", () => {
  it("leaves simple values unquoted", () => {
    expect(stringifyCsvRow(["a", "b", "c"])).toBe("a,b,c");
  });

  it("coerces null/undefined to empty", () => {
    expect(stringifyCsvRow(["a", null, undefined, "d"])).toBe("a,,,d");
  });

  it("quotes values with commas, quotes, or newlines", () => {
    expect(stringifyCsvRow(['he said "hi"', "a,b", "line\n2"])).toBe(
      '"he said ""hi""","a,b","line\n2"',
    );
  });
});

describe("stringifyCsv", () => {
  it("emits header + CRLF-separated rows with trailing newline", () => {
    const csv = stringifyCsv(
      ["email", "action"],
      [
        ["a@example.com", "auto_trash"],
        ["b@example.com", "review"],
      ],
    );
    expect(csv).toBe(
      "email,action\r\na@example.com,auto_trash\r\nb@example.com,review\r\n",
    );
  });
});

describe("parseCsv", () => {
  it("round-trips simple rows", () => {
    const rows = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("handles quoted fields with commas and escaped quotes", () => {
    const rows = parseCsv('email,note\r\n"a@b.com","he said ""hi"""\r\n');
    expect(rows).toEqual([
      ["email", "note"],
      ["a@b.com", 'he said "hi"'],
    ]);
  });

  it("handles embedded newlines inside quotes", () => {
    const rows = parseCsv('a,b\n"multi\nline",ok\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["multi\nline", "ok"],
    ]);
  });

  it("does not emit an empty trailing row", () => {
    expect(parseCsv("a,b\n1,2\n")).toHaveLength(2);
    expect(parseCsv("a,b\n1,2")).toHaveLength(2);
  });

  it("treats unquoted empty fields as empty strings", () => {
    const rows = parseCsv("a,b,c\n1,,3\n");
    expect(rows[1]).toEqual(["1", "", "3"]);
  });

  it("throws on an unterminated quoted field", () => {
    expect(() => parseCsv('a\n"broken')).toThrow(CsvParseError);
  });

  it("throws when a bare quote appears mid-field", () => {
    expect(() => parseCsv('a\nfo"o\n')).toThrow(CsvParseError);
  });
});
