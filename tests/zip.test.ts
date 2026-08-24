import { describe, expect, test } from "bun:test";
import { crc32, unzip, unzipSingleText, ZipError, zipSync } from "@/utils/zip";
import {
  COMMENTED_ZIP,
  DEFLATE_ZIP,
  MULTI_ZIP,
  REPORT_CSV,
  STORED_ZIP,
  TINY_CSV,
} from "./fixtures/zip-archives";

const b = (base64: string) => Buffer.from(base64, "base64");

describe("unzip", () => {
  test("inflates a deflate-compressed entry", () => {
    const entries = unzip(b(DEFLATE_ZIP));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("report.csv");
    expect(entries[0]?.data.toString("utf8")).toBe(REPORT_CSV);
  });

  test("reads a stored (uncompressed) entry", () => {
    const entries = unzip(b(STORED_ZIP));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("tiny.csv");
    expect(entries[0]?.data.toString("utf8")).toBe(TINY_CSV);
  });

  test("reads every entry in a multi-file archive", () => {
    const entries = unzip(b(MULTI_ZIP));
    expect(entries.map((e) => e.name).sort()).toEqual(["report.csv", "tiny.csv"]);
    const byName = new Map(entries.map((e) => [e.name, e.data.toString("utf8")]));
    expect(byName.get("report.csv")).toBe(REPORT_CSV);
    expect(byName.get("tiny.csv")).toBe(TINY_CSV);
  });

  test("finds the EOCD when a trailing archive comment follows it", () => {
    const entries = unzip(b(COMMENTED_ZIP));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data.toString("utf8")).toBe(TINY_CSV);
  });

  test("accepts a Uint8Array and an ArrayBuffer, not just a Buffer", () => {
    const buf = b(STORED_ZIP);
    const fromU8 = unzip(new Uint8Array(buf));
    const fromAb = unzip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    expect(fromU8[0]?.data.toString("utf8")).toBe(TINY_CSV);
    expect(fromAb[0]?.data.toString("utf8")).toBe(TINY_CSV);
  });

  test("rejects a buffer too short to hold an EOCD", () => {
    expect(() => unzip(Buffer.from("nope"))).toThrow(ZipError);
  });

  test("rejects a well-sized buffer that is not a ZIP", () => {
    expect(() => unzip(Buffer.alloc(500, 0x41))).toThrow(/no end-of-central-directory/);
  });
});

describe("unzipSingleText", () => {
  test("returns the sole entry's text", () => {
    expect(unzipSingleText(b(DEFLATE_ZIP))).toBe(REPORT_CSV);
  });

  test("throws, naming the entries, when the archive holds more than one file", () => {
    expect(() => unzipSingleText(b(MULTI_ZIP))).toThrow(
      /found 2: report\.csv, tiny\.csv/,
    );
  });
});

describe("corruption detection", () => {
  test("rejects an entry whose bytes do not match its declared size", () => {
    const buf = Buffer.from(b(STORED_ZIP));
    // Overwrite the uncompressed-size field in the central directory header
    // (signature 0x02014b50, field at +24) with a wrong value. Offsets stay
    // valid, so this isolates the size check from structural corruption —
    // which is what a truncated download actually looks like.
    const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(cd).toBeGreaterThan(0);
    buf.writeUInt32LE(9999, cd + 24);
    expect(() => unzip(buf)).toThrow(/truncated or corrupt/);
  });

  test("accepts the same archive untouched", () => {
    expect(() => unzip(b(STORED_ZIP))).not.toThrow();
  });
});

describe("zipSync", () => {
  test("round-trips through the reader", () => {
    const archive = zipSync([{ name: "a.csv", data: "x,y\n1,2\n" }]);
    const entries = unzip(archive);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("a.csv");
    expect(entries[0]?.data.toString("utf8")).toBe("x,y\n1,2\n");
  });

  test("round-trips a payload large enough to actually deflate", () => {
    const big = `col\n${"row-value\n".repeat(5000)}`;
    const archive = zipSync([{ name: "big.csv", data: big }]);
    // Highly repetitive text must compress, or the writer is not deflating.
    expect(archive.length).toBeLessThan(big.length / 2);
    expect(unzipSingleText(archive)).toBe(big);
  });

  test("stores rather than deflates when compression would grow the payload", () => {
    // Random bytes are incompressible; deflate would add framing overhead.
    const random = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 97 + 13) % 256));
    const archive = zipSync([{ name: "r.bin", data: random }]);
    expect(unzip(archive)[0]?.data.equals(random)).toBe(true);
  });

  test("round-trips multiple entries", () => {
    const archive = zipSync([
      { name: "one.csv", data: "1" },
      { name: "two.csv", data: "2" },
    ]);
    const byName = new Map(unzip(archive).map((e) => [e.name, e.data.toString()]));
    expect(byName.get("one.csv")).toBe("1");
    expect(byName.get("two.csv")).toBe("2");
  });

  test("preserves UTF-8 content and filenames", () => {
    const archive = zipSync([{ name: "ünïcode.csv", data: "naïve,café\n" }]);
    const entry = unzip(archive)[0];
    expect(entry?.name).toBe("ünïcode.csv");
    expect(entry?.data.toString("utf8")).toBe("naïve,café\n");
  });

  test("preserves a UTF-8 BOM, which bulk upload requires", () => {
    const withBom = `﻿Type,Status\nCampaign,Active\n`;
    expect(unzipSingleText(zipSync([{ name: "b.csv", data: withBom }]))).toBe(withBom);
  });

  test("is byte-for-byte reproducible", () => {
    // Fixed timestamps mean identical input yields an identical archive,
    // which keeps uploads diffable and caches stable.
    const a = zipSync([{ name: "x.csv", data: "same" }]);
    const b = zipSync([{ name: "x.csv", data: "same" }]);
    expect(a.equals(b)).toBe(true);
  });

  test("refuses to build an empty archive", () => {
    expect(() => zipSync([])).toThrow(ZipError);
  });
});

describe("crc32", () => {
  test("matches the known digest for a standard input", () => {
    // "hello" → 0x3610a686 is a well-known CRC-32 check value.
    expect(crc32(Buffer.from("hello")).toString(16)).toBe("3610a686");
  });

  test("returns 0 for empty input", () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe("malformed archive handling", () => {
  test("a corrupt local-header offset raises ZipError, not RangeError", () => {
    const buf = Buffer.from(b(STORED_ZIP));
    // Central directory header (0x02014b50); local-header offset sits at +42.
    const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt32LE(0xfffffff0, cd + 42);
    // Without a bounds check Buffer.readUInt32LE throws RangeError, which is
    // an internal error rather than "your download is corrupt".
    expect(() => unzip(buf)).toThrow(ZipError);
    expect(() => unzip(buf)).toThrow(/malformed/);
  });

  test("a Zip64 sentinel with no extra field raises ZipError", () => {
    const buf = Buffer.from(b(STORED_ZIP));
    const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    // 0xFFFFFFFF means "look in the Zip64 extra field" — which is absent here.
    buf.writeUInt32LE(0xffffffff, cd + 42);
    expect(() => unzip(buf)).toThrow(ZipError);
  });

  test("bounds the inflate rather than trusting the archive", () => {
    // A declared size far below the real payload must fail, not allocate.
    const archive = zipSync([{ name: "a.csv", data: "x".repeat(20_000) }]);
    const cd = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    archive.writeUInt32LE(8, cd + 24); // claim 8 uncompressed bytes
    expect(() => unzip(archive)).toThrow();
  });
});
