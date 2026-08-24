import { describe, expect, test } from "bun:test";
import { rowsToTsv } from "@/utils/tsv";

describe("rowsToTsv", () => {
  test("returns empty string for no rows", () => {
    expect(rowsToTsv([])).toBe("");
  });

  test("emits a header row then one line per row", () => {
    const tsv = rowsToTsv([
      { a: 1, b: "x" },
      { a: 2, b: "y" },
    ]);
    expect(tsv).toBe("a\tb\n1\tx\n2\ty");
  });

  test("unions keys across every retained row so late sparse fields survive", () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      index === 59 ? { a: index, late: "kept" } : { a: index },
    );
    const tsv = rowsToTsv(rows);
    expect(tsv.split("\n")[0]).toBe("a\tlate");
    expect(tsv.split("\n")[60]).toBe("59\tkept");
  });

  test("uses a known column list in its declared order", () => {
    const tsv = rowsToTsv([{ a: 1, late: 2 }], ["late", "a", "missing"]);
    expect(tsv).toBe("late\ta\tmissing\n2\t1\t");
  });

  test("collapses tabs and newlines inside values", () => {
    const tsv = rowsToTsv([{ a: "one\ttwo\nthree\r" }]);
    expect(tsv.split("\n")[1]).toBe("one two three ");
  });

  test("JSON-stringifies object values", () => {
    const tsv = rowsToTsv([{ a: { nested: true } }]);
    expect(tsv.split("\n")[1]).toBe('{"nested":true}');
  });

  test("renders null and undefined as empty cells", () => {
    const tsv = rowsToTsv([{ a: null, b: undefined, c: 0 }]);
    expect(tsv).toBe("a\tb\tc\n\t\t0");
  });
});
