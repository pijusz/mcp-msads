import zlib, { inflateRawSync } from "node:zlib";

/**
 * Minimal ZIP archive reader.
 *
 * Microsoft Advertising delivers Reporting and Bulk results as a ZIP containing
 * one CSV. Node has no built-in ZIP reader (`node:zlib` only does raw deflate
 * streams), so rather than take a dependency we parse the container here — it
 * is ~150 lines and both reference servers stay at two runtime deps.
 *
 * Supports: stored (method 0) and deflate (method 8) entries, and Zip64 for
 * archives over 4 GB / 65535 entries. Encryption is not supported; Microsoft
 * does not encrypt these downloads.
 *
 * Format reference: PKWARE APPNOTE.TXT 6.3.x.
 */

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL_FILE = 0x02014b50;
const SIG_LOCAL_FILE = 0x04034b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export const MAX_ZIP_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

/** Max size of the trailing ZIP comment, which sits after the EOCD record. */
const MAX_COMMENT = 0xffff;
const EOCD_MIN_SIZE = 22;

export interface ZipEntry {
  name: string;
  /** Decompressed bytes. */
  data: Buffer;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

/**
 * Scan backwards from the end of the buffer for the End Of Central Directory
 * signature. It is the last 22 bytes unless the archive carries a comment, so
 * we search the final 22 + 65535 bytes.
 */
function findEocd(buf: Buffer): number {
  const searchStart = Math.max(0, buf.length - (EOCD_MIN_SIZE + MAX_COMMENT));
  for (let i = buf.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new ZipError("Not a ZIP archive: no end-of-central-directory record found.");
}

interface CentralDirectoryLocation {
  offset: number;
  entries: number;
}

/**
 * Resolve where the central directory starts and how many entries it holds,
 * following the Zip64 locator when the 32-bit fields are saturated (0xFFFFFFFF
 * / 0xFFFF are the "look in Zip64" sentinels).
 */
function locateCentralDirectory(buf: Buffer, eocd: number): CentralDirectoryLocation {
  const entries32 = buf.readUInt16LE(eocd + 10);
  const offset32 = buf.readUInt32LE(eocd + 16);

  const saturated = offset32 === 0xffffffff || entries32 === 0xffff;
  if (!saturated) return { offset: offset32, entries: entries32 };

  const locator = eocd - 20;
  if (locator < 0 || buf.readUInt32LE(locator) !== SIG_ZIP64_LOCATOR) {
    throw new ZipError("Zip64 archive is missing its end-of-central-directory locator.");
  }
  const zip64Eocd = readUInt64LE(buf, locator + 8);
  assertReadable(buf, zip64Eocd, 56, "the Zip64 end-of-central-directory record");
  if (buf.readUInt32LE(zip64Eocd) !== SIG_ZIP64_EOCD) {
    throw new ZipError("Zip64 end-of-central-directory record is malformed.");
  }
  return {
    offset: readUInt64LE(buf, zip64Eocd + 48),
    entries: readUInt64LE(buf, zip64Eocd + 32),
  };
}

/**
 * Read a 64-bit little-endian value as a JS number.
 * Throws above 2^53-1 rather than silently losing precision.
 */
/** Bounds-check before reading, so a corrupt offset raises ZipError not RangeError. */
function assertReadable(buf: Buffer, offset: number, length: number, what: string): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + length > buf.length) {
    throw new ZipError(
      `ZIP archive is malformed: ${what} points to offset ${offset}, outside the ${buf.length}-byte archive. The download is corrupt or truncated.`,
    );
  }
}

function readUInt64LE(buf: Buffer, offset: number): number {
  assertReadable(buf, offset, 8, "a Zip64 field");
  const value = buf.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipError(`ZIP offset ${value} exceeds the safe integer range.`);
  }
  return Number(value);
}

/**
 * Pull the overridden sizes/offset out of a Zip64 extended-information extra
 * field (header id 0x0001). Values appear in a fixed order but only for the
 * fields that were saturated in the central header, so we consume them in
 * sequence and only for the ones the caller says are missing.
 */
function readZip64Extra(
  extra: Buffer,
  need: { size: boolean; compressedSize: boolean; offset: boolean },
): { size?: number; compressedSize?: number; offset?: number } {
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(pos);
    const dataSize = extra.readUInt16LE(pos + 2);
    const dataStart = pos + 4;
    if (headerId === 0x0001) {
      const out: { size?: number; compressedSize?: number; offset?: number } = {};
      let cursor = dataStart;
      if (need.size && cursor + 8 <= dataStart + dataSize) {
        out.size = readUInt64LE(extra, cursor);
        cursor += 8;
      }
      if (need.compressedSize && cursor + 8 <= dataStart + dataSize) {
        out.compressedSize = readUInt64LE(extra, cursor);
        cursor += 8;
      }
      if (need.offset && cursor + 8 <= dataStart + dataSize) {
        out.offset = readUInt64LE(extra, cursor);
      }
      return out;
    }
    pos = dataStart + dataSize;
  }
  return {};
}

function decompress(
  method: number,
  payload: Buffer,
  expectedSize: number,
  name: string,
): Buffer {
  let out: Buffer;
  if (method === METHOD_STORED) {
    out = payload;
  } else if (method === METHOD_DEFLATE) {
    // Bounded by the declared size: a corrupt or hostile archive could
    // otherwise inflate to gigabytes before the size check below ever runs.
    out = inflateRawSync(payload, { maxOutputLength: Math.max(expectedSize, 1) });
  } else {
    throw new ZipError(
      `ZIP entry "${name}" uses unsupported compression method ${method}${
        method === 99 ? " (encrypted archives are not supported)" : ""
      }. Expected stored (0) or deflate (8).`,
    );
  }

  // The central directory declares the uncompressed size. A mismatch means a
  // truncated or corrupt download — worth failing loudly, because the parsed
  // CSV would otherwise look like a short but valid report.
  if (out.length !== expectedSize) {
    throw new ZipError(
      `ZIP entry "${name}" decompressed to ${out.length} bytes but the archive declares ${expectedSize}. The download is truncated or corrupt; fetch it again.`,
    );
  }
  return out;
}

/**
 * Read every entry in a ZIP archive held in memory.
 *
 * Directory entries (names ending in "/") are skipped — Microsoft's archives
 * are flat, but a stray directory entry should not become an empty CSV.
 */
export function unzip(
  archive: Buffer | Uint8Array | ArrayBuffer,
  maxUncompressedBytes = MAX_ZIP_UNCOMPRESSED_BYTES,
): ZipEntry[] {
  const buf = Buffer.isBuffer(archive) ? archive : Buffer.from(archive as ArrayBuffer);
  if (buf.length < EOCD_MIN_SIZE) {
    throw new ZipError(`Not a ZIP archive: only ${buf.length} bytes.`);
  }

  const eocd = findEocd(buf);
  const { offset: cdOffset, entries: entryCount } = locateCentralDirectory(buf, eocd);

  const out: ZipEntry[] = [];
  let totalUncompressedBytes = 0;
  let pos = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== SIG_CENTRAL_FILE) {
      throw new ZipError(`Central directory entry ${i} is malformed.`);
    }
    const method = buf.readUInt16LE(pos + 10);
    let compressedSize = buf.readUInt32LE(pos + 20);
    let size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    let localOffset = buf.readUInt32LE(pos + 42);

    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    const extra = buf.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen);

    const need = {
      size: size === 0xffffffff,
      compressedSize: compressedSize === 0xffffffff,
      offset: localOffset === 0xffffffff,
    };
    if (need.size || need.compressedSize || need.offset) {
      const z64 = readZip64Extra(extra, need);
      if (z64.size !== undefined) size = z64.size;
      if (z64.compressedSize !== undefined) compressedSize = z64.compressedSize;
      if (z64.offset !== undefined) localOffset = z64.offset;
    }

    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;
    totalUncompressedBytes += size;
    if (totalUncompressedBytes > maxUncompressedBytes) {
      throw new ZipError(
        `ZIP contents declare ${totalUncompressedBytes} decompressed bytes, exceeding the ${maxUncompressedBytes}-byte limit. Narrow the requested data.`,
      );
    }

    // The local header repeats the name/extra lengths, and its extra field can
    // differ in length from the central one — always read the local values.
    assertReadable(buf, localOffset, 30, `the local header for "${name}"`);
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL_FILE) {
      throw new ZipError(`Local file header for "${name}" is malformed.`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    assertReadable(buf, dataStart, compressedSize, `the data for "${name}"`);
    const payload = buf.subarray(dataStart, dataStart + compressedSize);

    out.push({ name, data: decompress(method, payload, size, name) });
  }

  return out;
}

/**
 * Convenience for the common Microsoft case: an archive holding exactly one
 * text file. Returns its decoded contents.
 */
export function unzipSingleText(
  archive: Buffer | Uint8Array | ArrayBuffer,
  encoding: BufferEncoding = "utf8",
  maxUncompressedBytes = MAX_ZIP_UNCOMPRESSED_BYTES,
): string {
  const entries = unzip(archive, maxUncompressedBytes);
  if (entries.length === 0) {
    throw new ZipError("ZIP archive is empty — expected one file.");
  }
  const first = entries[0];
  if (!first) throw new ZipError("ZIP archive is empty — expected one file.");
  // Microsoft ships a single CSV; if that ever changes, take the first and say so.
  if (entries.length > 1) {
    const names = entries.map((e) => e.name).join(", ");
    throw new ZipError(
      `Expected one file in the ZIP archive but found ${entries.length}: ${names}`,
    );
  }
  return first.data.toString(encoding);
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/**
 * CRC-32 lookup table, built once on first use.
 *
 * `node:zlib.crc32` exists on Node 20.15+ and on Bun, and is used when
 * present. This fallback keeps the compiled binary working regardless of the
 * runtime it is embedded against — the table costs a few microseconds to build
 * and removes the question entirely.
 */
let crcTable: Int32Array | null = null;

function buildCrcTable(): Int32Array {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
}

export function crc32(buf: Buffer): number {
  const native = (zlib as { crc32?: (b: Buffer) => number }).crc32;
  if (typeof native === "function") return native(buf) >>> 0;

  crcTable ??= buildCrcTable();
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index is masked to 0-255
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]!) & 0xff]!;
  }
  return (crc ^ -1) >>> 0;
}

export interface ZipInput {
  name: string;
  data: Buffer | string;
}

/**
 * Build a ZIP archive in memory.
 *
 * Written for Bulk upload, which requires a ZIP containing one CSV or TSV with
 * "a valid end-of-central-directory record" — Microsoft rejects malformed
 * archives outright.
 *
 * Entries are deflated unless that makes them larger, in which case they are
 * stored. Zip64 is not emitted: bulk uploads cap at 100 MB, far under the
 * 4 GB point where it becomes necessary.
 */
export function zipSync(entries: ZipInput[]): Buffer {
  if (entries.length === 0) {
    throw new ZipError("Cannot build an empty ZIP archive.");
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, "utf8");
    const checksum = crc32(raw);

    const deflated = zlib.deflateRawSync(raw);
    // Deflate can inflate already-compressed or tiny payloads.
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORED;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL_FILE, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // flag: filename is UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time — fixed, so output is reproducible
    local.writeUInt16LE(0x0021, 12); // mod date — 1980-01-01, the ZIP epoch
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // no extra field

    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL_FILE, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(EOCD_MIN_SIZE);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // no archive comment

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}
