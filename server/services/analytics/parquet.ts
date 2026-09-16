/**
 * MINIMAL PARQUET WRITER — Parquet v1 data pages, ZSTD compressed.
 *
 * Why hand-rolled rather than a library: the analytics lake needs exactly
 * one shape of file — a flat, all-optional row of scalars (strings, int32,
 * int64 timestamps) written once per flush — and every JS Parquet library
 * that covers that either ships a native binary, a WASM blob, or drags in a
 * compression stack we would then have to keep patched. Node 22 already has
 * ZSTD in `zlib`, so the only thing actually missing is ~400 lines of
 * Thrift-compact encoding. That is a smaller, more auditable dependency
 * surface than any of the alternatives, and it keeps the HARD CONSTRAINT
 * "no new services, no new heavy runtime deps" intact.
 *
 * What it deliberately does NOT do: nested/repeated fields, multiple row
 * groups, dictionary encoding, column statistics, bloom filters. Every one
 * of those is a real Parquet feature and every one is unnecessary here — a
 * flush is one row group of flat columns. PLAIN + ZSTD on a column of
 * repeated low-cardinality strings (browser, country, utm_source) already
 * compresses to roughly what a dictionary would cost, because that is what
 * ZSTD does.
 *
 * The output is verified against DuckDB in
 * src/test/analytics/parquetRoundTrip.test.ts — the same engine the Phase 2
 * read path will use — so "it parses in our own reader" is never the proof.
 */
import { constants as zlibConstants, zstdCompressSync } from 'node:zlib';

/**
 * ZSTD landed in node:zlib in Node 22.15. On an older runtime the import
 * above resolves to `undefined` and the first flush would die with an
 * opaque "not a function" deep inside page encoding.
 *
 * Checked once, at module load, so the failure is a single legible message
 * naming the requirement instead of one cryptic TypeError per flush.
 */
if (typeof zstdCompressSync !== 'function') {
  throw new Error(
    'analytics_parquet_unsupported_runtime: the Web Analytics Parquet writer compresses with '
    + `ZSTD via node:zlib, which requires Node >= 22.15 (this process is ${process.version}). `
    + 'Upgrade the runtime — see the engines field in package.json.',
  );
}

// ─── Parquet enums (parquet.thrift) ──────────────────────────────

const enum PhysicalType { BOOLEAN = 0, INT32 = 1, INT64 = 2, BYTE_ARRAY = 6 }
const enum Repetition { REQUIRED = 0, OPTIONAL = 1 }
const enum ConvertedType { UTF8 = 0, TIMESTAMP_MILLIS = 9 }
const enum Encoding { PLAIN = 0, RLE = 3 }
const enum Codec { ZSTD = 6 }
const enum PageType { DATA_PAGE = 0 }

const MAGIC = Buffer.from('PAR1', 'ascii');

// ─── Thrift compact protocol ─────────────────────────────────────
//
// Only the subset the Parquet footer needs: struct / list / i32 / i64 /
// binary. Field ids are written as a delta from the previous field in the
// same struct, which is why every writer here emits fields in ascending id
// order and why `ThriftWriter` tracks the last id per nesting level.

const enum TType { BOOL_TRUE = 1, I32 = 5, I64 = 6, BINARY = 8, LIST = 9, STRUCT = 12 }

class ThriftWriter {
  private chunks: Buffer[] = [];
  private lastFieldId = 0;
  private stack: number[] = [];

  private push(b: Buffer): void { this.chunks.push(b); }

  private varint(value: number | bigint): void {
    let v = BigInt(value);
    const out: number[] = [];
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    this.push(Buffer.from(out));
  }

  private zigzag(value: number | bigint): void {
    const v = BigInt(value);
    this.varint((v << 1n) ^ (v >> 63n));
  }

  /** Field header: 4-bit delta + 4-bit type, or 0x0_ + explicit zigzag id. */
  private fieldHeader(id: number, type: TType): void {
    const delta = id - this.lastFieldId;
    if (delta > 0 && delta <= 15) {
      this.push(Buffer.from([(delta << 4) | type]));
    } else {
      this.push(Buffer.from([type]));
      this.zigzag(id);
    }
    this.lastFieldId = id;
  }

  structBegin(): void { this.stack.push(this.lastFieldId); this.lastFieldId = 0; }
  structEnd(): void { this.push(Buffer.from([0])); this.lastFieldId = this.stack.pop() ?? 0; }

  fieldI32(id: number, value: number): void { this.fieldHeader(id, TType.I32); this.zigzag(value); }
  fieldI64(id: number, value: number | bigint): void { this.fieldHeader(id, TType.I64); this.zigzag(value); }
  fieldBool(id: number, value: boolean): void {
    // Compact protocol folds a boolean's value into its type nibble.
    const delta = id - this.lastFieldId;
    const type = value ? 1 : 2;
    if (delta > 0 && delta <= 15) this.push(Buffer.from([(delta << 4) | type]));
    else { this.push(Buffer.from([type])); this.zigzag(id); }
    this.lastFieldId = id;
  }

  fieldBinary(id: number, value: Buffer): void {
    this.fieldHeader(id, TType.BINARY);
    this.varint(value.length);
    this.push(value);
  }

  fieldString(id: number, value: string): void { this.fieldBinary(id, Buffer.from(value, 'utf8')); }

  fieldStruct(id: number, write: () => void): void {
    this.fieldHeader(id, TType.STRUCT);
    this.structBegin();
    write();
    this.structEnd();
  }

  private listHeader(size: number, elemType: TType): void {
    if (size < 15) this.push(Buffer.from([(size << 4) | elemType]));
    else { this.push(Buffer.from([0xf0 | elemType])); this.varint(size); }
  }

  fieldListI32(id: number, values: number[]): void {
    this.fieldHeader(id, TType.LIST);
    this.listHeader(values.length, TType.I32);
    for (const v of values) this.zigzag(v);
  }

  fieldListString(id: number, values: string[]): void {
    this.fieldHeader(id, TType.LIST);
    this.listHeader(values.length, TType.BINARY);
    for (const v of values) {
      const b = Buffer.from(v, 'utf8');
      this.varint(b.length);
      this.push(b);
    }
  }

  fieldListStruct(id: number, count: number, write: (index: number) => void): void {
    this.fieldHeader(id, TType.LIST);
    this.listHeader(count, TType.STRUCT);
    for (let i = 0; i < count; i++) {
      this.structBegin();
      write(i);
      this.structEnd();
    }
  }

  finish(): Buffer { return Buffer.concat(this.chunks); }
}

// ─── Column definitions ──────────────────────────────────────────

export type ParquetColumnType = 'utf8' | 'int32' | 'int64' | 'timestamp_ms' | 'boolean';

export interface ParquetColumn {
  name: string;
  type: ParquetColumnType;
}

/** One column's values, aligned with every other column by row index. */
export type ParquetValue = string | number | bigint | boolean | null | undefined;

function physicalOf(type: ParquetColumnType): PhysicalType {
  switch (type) {
    case 'utf8': return PhysicalType.BYTE_ARRAY;
    case 'int32': return PhysicalType.INT32;
    case 'int64':
    case 'timestamp_ms': return PhysicalType.INT64;
    case 'boolean': return PhysicalType.BOOLEAN;
  }
}

function convertedOf(type: ParquetColumnType): ConvertedType | null {
  if (type === 'utf8') return ConvertedType.UTF8;
  if (type === 'timestamp_ms') return ConvertedType.TIMESTAMP_MILLIS;
  return null;
}

// ─── Level + value encoding ──────────────────────────────────────

/**
 * RLE/bit-packed hybrid for definition levels at bit width 1 (every column
 * is OPTIONAL and flat, so max definition level is 1). Only RLE runs are
 * emitted — a bit-packed run is never smaller for a two-value alphabet at
 * this width, and emitting one kind of run keeps the encoder trivially
 * verifiable.
 *
 * DataPageV1 prefixes the level section with its byte length; DataPageV2
 * carries it in the header instead. This writer emits V1.
 */
function encodeDefinitionLevels(levels: Uint8Array): Buffer {
  const runs: Buffer[] = [];
  let i = 0;
  while (i < levels.length) {
    const value = levels[i];
    let run = 1;
    while (i + run < levels.length && levels[i + run] === value) run++;
    // RLE run header: varint((runLength << 1) | 0), then the value in
    // ceil(bitWidth / 8) = 1 byte.
    const header: number[] = [];
    let h = run << 1;
    while (h >= 0x80) { header.push((h & 0x7f) | 0x80); h >>>= 7; }
    header.push(h);
    runs.push(Buffer.from([...header, value]));
    i += run;
  }
  const body = Buffer.concat(runs);
  const prefixed = Buffer.allocUnsafe(4 + body.length);
  prefixed.writeUInt32LE(body.length, 0);
  body.copy(prefixed, 4);
  return prefixed;
}

function isNull(v: ParquetValue): boolean {
  return v === null || v === undefined;
}

/** PLAIN encoding of the non-null values, in row order. */
function encodePlain(type: ParquetColumnType, values: ParquetValue[]): Buffer {
  const physical = physicalOf(type);
  const parts: Buffer[] = [];

  if (physical === PhysicalType.BYTE_ARRAY) {
    for (const v of values) {
      if (isNull(v)) continue;
      const bytes = Buffer.from(String(v), 'utf8');
      const head = Buffer.allocUnsafe(4);
      head.writeUInt32LE(bytes.length, 0);
      parts.push(head, bytes);
    }
    return Buffer.concat(parts);
  }

  if (physical === PhysicalType.INT32) {
    const present = values.filter((v) => !isNull(v));
    const buf = Buffer.allocUnsafe(present.length * 4);
    present.forEach((v, i) => buf.writeInt32LE(Number(v) | 0, i * 4));
    return buf;
  }

  if (physical === PhysicalType.INT64) {
    const present = values.filter((v) => !isNull(v));
    const buf = Buffer.allocUnsafe(present.length * 8);
    present.forEach((v, i) => buf.writeBigInt64LE(BigInt(v as number | bigint), i * 8));
    return buf;
  }

  // BOOLEAN — bit-packed, least-significant bit first.
  const present = values.filter((v) => !isNull(v));
  const buf = Buffer.alloc(Math.ceil(present.length / 8));
  present.forEach((v, i) => { if (v) buf[i >> 3] |= 1 << (i & 7); });
  return buf;
}

// ─── File assembly ───────────────────────────────────────────────

export interface ParquetFile {
  buffer: Buffer;
  rowCount: number;
}

interface ChunkPlan {
  column: ParquetColumn;
  page: Buffer;
  uncompressedSize: number;
  compressedSize: number;
  offset: number;
}

/**
 * Write one Parquet file: a single row group, one ZSTD-compressed
 * DataPageV1 per column.
 *
 * `columns` fixes the order; `rows` maps each column name to its value for
 * that row. A missing key is a null, which is why every column is declared
 * OPTIONAL — a schema addition must never invalidate files written before
 * it existed.
 */
export function writeParquet(
  columns: ParquetColumn[],
  rows: Record<string, ParquetValue>[],
  opts?: { createdBy?: string; zstdLevel?: number },
): ParquetFile {
  if (columns.length === 0) throw new Error('parquet_write_failed: no columns');

  const level = opts?.zstdLevel ?? 3;
  const body: Buffer[] = [MAGIC];
  let offset = MAGIC.length;
  const plans: ChunkPlan[] = [];

  for (const column of columns) {
    const values = rows.map((row) => row[column.name] ?? null);
    const levels = new Uint8Array(values.length);
    for (let i = 0; i < values.length; i++) levels[i] = isNull(values[i]) ? 0 : 1;

    const levelBytes = values.length > 0 ? encodeDefinitionLevels(levels) : Buffer.alloc(4);
    const valueBytes = encodePlain(column.type, values);
    const raw = Buffer.concat([levelBytes, valueBytes]);
    const compressed = zstdCompressSync(raw, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: level },
    });

    const header = new ThriftWriter();
    header.structBegin();
    header.fieldI32(1, PageType.DATA_PAGE);
    header.fieldI32(2, raw.length);
    header.fieldI32(3, compressed.length);
    header.fieldStruct(5, () => {
      header.fieldI32(1, values.length);
      header.fieldI32(2, Encoding.PLAIN);
      header.fieldI32(3, Encoding.RLE);
      header.fieldI32(4, Encoding.RLE);
    });
    header.structEnd();
    const headerBytes = header.finish();

    const page = Buffer.concat([headerBytes, compressed]);
    plans.push({
      column,
      page,
      // The sizes the footer reports are PAGE sizes — the page header counts
      // toward both, which is what readers use to walk from one chunk to the
      // next. Reporting only the payload makes the chunk look short.
      uncompressedSize: headerBytes.length + raw.length,
      compressedSize: page.length,
      offset,
    });
    body.push(page);
    offset += page.length;
  }

  // ── Footer ──
  const meta = new ThriftWriter();
  meta.structBegin();
  meta.fieldI32(1, 1); // version
  meta.fieldListStruct(2, columns.length + 1, (i) => {
    if (i === 0) {
      meta.fieldString(4, 'schema');
      meta.fieldI32(5, columns.length);
      return;
    }
    const column = columns[i - 1];
    const converted = convertedOf(column.type);
    meta.fieldI32(1, physicalOf(column.type));
    meta.fieldI32(3, Repetition.OPTIONAL);
    meta.fieldString(4, column.name);
    if (converted !== null) meta.fieldI32(6, converted);
  });
  meta.fieldI64(3, rows.length);
  meta.fieldListStruct(4, 1, () => {
    meta.fieldListStruct(1, plans.length, (i) => {
      const plan = plans[i];
      meta.fieldI64(2, plan.offset);
      meta.fieldStruct(3, () => {
        meta.fieldI32(1, physicalOf(plan.column.type));
        meta.fieldListI32(2, [Encoding.PLAIN, Encoding.RLE]);
        meta.fieldListString(3, [plan.column.name]);
        meta.fieldI32(4, Codec.ZSTD);
        meta.fieldI64(5, rows.length);
        meta.fieldI64(6, plan.uncompressedSize);
        meta.fieldI64(7, plan.compressedSize);
        meta.fieldI64(9, plan.offset);
      });
    });
    meta.fieldI64(2, plans.reduce((sum, p) => sum + p.uncompressedSize, 0));
    meta.fieldI64(3, rows.length);
  });
  meta.fieldString(6, opts?.createdBy ?? 'webyar-analytics');
  meta.structEnd();

  const footer = meta.finish();
  const footerLength = Buffer.allocUnsafe(4);
  footerLength.writeUInt32LE(footer.length, 0);

  return {
    buffer: Buffer.concat([...body, footer, footerLength, MAGIC]),
    rowCount: rows.length,
  };
}
