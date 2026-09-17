import { describe, expect, it } from "vitest";
import { toCsv } from "../../src/lib/csv";

describe("toCsv", () => {
  it("writes a header and CRLF-terminated rows in column order", () => {
    expect(toCsv(["b", "a"], [{ a: "1", b: "2" }])).toBe("b,a\r\n2,1\r\n");
  });

  it("writes just the header for no rows", () => {
    expect(toCsv(["a"], [])).toBe("a\r\n");
  });

  it("quotes cells containing commas, quotes, or line breaks", () => {
    expect(toCsv(["a"], [{ a: 'Rivera, "Sam"' }, { a: "two\nlines" }])).toBe(
      'a\r\n"Rivera, ""Sam"""\r\n"two\nlines"\r\n',
    );
  });

  it("writes null and undefined as empty cells, and numbers as-is", () => {
    expect(toCsv(["a", "b", "c"], [{ a: null, b: undefined, c: -5 }])).toBe("a,b,c\r\n,,-5\r\n");
  });

  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"])(
    "neutralizes a text cell a spreadsheet would run as a formula: %j",
    (value) => {
      const [, cell] = toCsv(["a"], [{ a: value }]).split("\r\n", 2);
      expect(cell.replace(/^"/, "").startsWith("'")).toBe(true);
    },
  );

  it("still quotes a neutralized cell that needs it", () => {
    expect(toCsv(["a"], [{ a: '=HYPERLINK("x","y")' }])).toBe('a\r\n"\'=HYPERLINK(""x"",""y"")"\r\n');
  });
});
