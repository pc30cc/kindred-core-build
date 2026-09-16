/**
 * The Parquet writer is hand-rolled (server/services/analytics/parquet.ts),
 * so it gets a structural test that decodes what it produced rather than one
 * that merely re-runs the encoder's own assumptions.
 *
 * The decoder below is written independently, straight from the Thrift
 * compact-protocol spec: generic field walking, zigzag varints, list headers.
 * It knows nothing about the writer's internals, so an encoder bug (a wrong
 * field id, a bad delta, a mis-stated page size) shows up here as a decode
 * failure or a wrong value — which is exactly what a circular
 * "write then read with the same code" test could not catch.
 *
 * The files are ALSO verified against DuckDB — the engine the Phase 2 read
 * path will use — during development; that cannot run in CI without adding a
 * native dependency, so this suite is what guards the format from here on.
 */
import { describe, expect, it } from 'vitest';
import { zstdDecompressSync } from 'node:zlib';
import { writeParquet, type ParquetColumn } from '../../../server/services/analytics/parquet';

// ─── Independent Thrift compact decoder ──────────────────────────

class Reader {
  offset = 0;
  constructor(private readonly buf: Buffer) {}

  byte(): number { return this.buf[this.offset++]; }

  varint(): bigint {
    let shift = 0n;
    let result = 0n;
    for (;;) {
      const b = this.byte();
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
  }

  zigzag(): bigint {
    const v = this.varint();
    return (v >> 1n) ^ -(v & 1n);
  }

  binary(): Buffer {
    const length = Number(this.varint());
    const out = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
}

type Field = bigint | string | Field[] | Record<string, Field>;

/** Decode one struct into `{ [fieldId]: value }`, recursing into structs and lists. */
function readStruct(r: Reader): Record<string, Field> {
  const out: Record<string, Field> = {};
  let lastId = 0;
  for (;;) {
    const header = r.byte();
    if (header === 0) return out;
    const type = header & 0x0f;
    const delta = header >> 4;
    const id = delta === 0 ? Number(r.zigzag()) : lastId + delta;
    lastId = id;
    out[String(id)] = readValue(r, type);
  }
}

function readValue(r: Reader, type: number): Field {
  switch (type) {
    case 1: return 1n;               // BOOLEAN_TRUE
    case 2: return 0n;               // BOOLEAN_FALSE
    case 5: case 6: return r.zigzag(); // I32 / I64
    case 8: return r.binary().toString('utf8');
    case 9: case 10: {               // LIST / SET
      const head = r.byte();
      const elemType = head & 0x0f;
      const size = (head >> 4) === 0x0f ? Number(r.varint()) : head >> 4;
      return Array.from({ length: size }, () => readValue(r, elemType));
    }
    case 12: return readStruct(r);
    default: throw new Error(`unsupported thrift type ${type}`);
  }
}

interface DecodedFile {
  meta: Record<string, Field>;
  numRows: number;
  schema: Record<string, Field>[];
  columns: Record<string, Field>[];
}

function decode(buffer: Buffer): DecodedFile {
  expect(buffer.subarray(0, 4).toString('ascii')).toBe('PAR1');
  expect(buffer.subarray(-4).toString('ascii')).toBe('PAR1');

  const footerLength = buffer.readUInt32LE(buffer.length - 8);
  const footerStart = buffer.length - 8 - footerLength;
  const meta = readStruct(new Reader(buffer.subarray(footerStart, buffer.length - 8)));

  const schema = meta['2'] as Record<string, Field>[];
  const rowGroups = meta['4'] as Record<string, Field>[];
  expect(rowGroups).toHaveLength(1);

  return {
    meta,
    numRows: Number(meta['3'] as bigint),
    schema,
    columns: rowGroups[0]['1'] as Record<string, Field>[],
  };
}

/** Pull one column's decompressed page payload straight out of the file. */
function pageOf(buffer: Buffer, column: Record<string, Field>): { header: Record<string, Field>; data: Buffer } {
  const chunkMeta = column['3'] as Record<string, Field>;
  const offset = Number(chunkMeta['9'] as bigint);
  const reader = new Reader(buffer.subarray(offset));
  const header = readStruct(reader);
  const compressedSize = Number(header['3'] as bigint);
  const start = offset + reader.offset;
  return { header, data: zstdDecompressSync(buffer.subarray(start, start + compressedSize)) };
}

/** Definition levels are RLE runs at bit width 1, behind a 4-byte length. */
function readDefinitionLevels(page: Buffer, count: number): { levels: number[]; rest: Buffer } {
  const length = page.readUInt32LE(0);
  const body = page.subarray(4, 4 + length);
  const levels: number[] = [];
  let i = 0;
  while (i < body.length && levels.length < count) {
    let header = 0;
    let shift = 0;
    for (;;) {
      const b = body[i++];
      header |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    expect(header & 1).toBe(0); // RLE run, never bit-packed
    const run = header >> 1;
    const value = body[i++];
    for (let n = 0; n < run; n++) levels.push(value);
  }
  return { levels, rest: page.subarray(4 + length) };
}

function readPlainStrings(buf: Buffer, count: number): string[] {
  const out: string[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const length = buf.readUInt32LE(offset);
    out.push(buf.subarray(offset + 4, offset + 4 + length).toString('utf8'));
    offset += 4 + length;
  }
  return out;
}

const COLUMNS: ParquetColumn[] = [
  { name: 'visitor_id', type: 'utf8' },
  { name: 'session_id', type: 'utf8' },
  { name: 'occurred_at', type: 'timestamp_ms' },
  { name: 'schema_version', type: 'int32' },
  { name: 'title', type: 'utf8' },
];

describe('analytics Parquet writer', () => {
  it('produces a structurally valid single-row-group file', () => {
    const file = writeParquet(COLUMNS, [
      { visitor_id: 'v1', session_id: 's1', occurred_at: 1789000000000, schema_version: 1, title: 'A' },
      { visitor_id: 'v1', session_id: 's2', occurred_at: 1789000001000, schema_version: 1, title: null },
    ]);

    const decoded = decode(file.buffer);
    expect(decoded.numRows).toBe(2);
    expect(Number(decoded.meta['1'] as bigint)).toBe(1); // format version
    // Root schema element + one per column.
    expect(decoded.schema).toHaveLength(COLUMNS.length + 1);
    expect(decoded.schema[0]['4']).toBe('schema');
    expect(Number(decoded.schema[0]['5'] as bigint)).toBe(COLUMNS.length);
    expect(decoded.columns).toHaveLength(COLUMNS.length);
  });

  it('declares every column OPTIONAL so a later schema addition never invalidates old files', () => {
    const file = writeParquet(COLUMNS, [{ visitor_id: 'v1' }]);
    for (const element of decode(file.buffer).schema.slice(1)) {
      expect(Number(element['3'] as bigint)).toBe(1); // FieldRepetitionType.OPTIONAL
    }
  });

  it('compresses every column chunk with ZSTD', () => {
    const file = writeParquet(COLUMNS, [{ visitor_id: 'v1', occurred_at: 1 }]);
    for (const column of decode(file.buffer).columns) {
      const chunkMeta = column['3'] as Record<string, Field>;
      expect(Number(chunkMeta['4'] as bigint)).toBe(6); // CompressionCodec.ZSTD
    }
  });

  it('round-trips string values and marks nulls with definition level 0', () => {
    const rows = [
      { title: 'first' },
      { title: null },
      { title: 'third' },
      {},               // a missing key is a null, exactly like an explicit one
    ];
    const file = writeParquet([{ name: 'title', type: 'utf8' }], rows);
    const decoded = decode(file.buffer);
    const { data } = pageOf(file.buffer, decoded.columns[0]);
    const { levels, rest } = readDefinitionLevels(data, rows.length);

    expect(levels).toEqual([1, 0, 1, 0]);
    // Only non-null values are encoded, in row order.
    expect(readPlainStrings(rest, 2)).toEqual(['first', 'third']);
  });

  it('round-trips int64 timestamps and int32 values', () => {
    const file = writeParquet(
      [{ name: 'occurred_at', type: 'timestamp_ms' }, { name: 'schema_version', type: 'int32' }],
      [{ occurred_at: 1789000000000, schema_version: 7 }, { occurred_at: 1789000009999, schema_version: 7 }],
    );
    const decoded = decode(file.buffer);

    const ts = pageOf(file.buffer, decoded.columns[0]);
    const tsValues = readDefinitionLevels(ts.data, 2).rest;
    expect(tsValues.readBigInt64LE(0)).toBe(1789000000000n);
    expect(tsValues.readBigInt64LE(8)).toBe(1789000009999n);

    const version = pageOf(file.buffer, decoded.columns[1]);
    const versionValues = readDefinitionLevels(version.data, 2).rest;
    expect(versionValues.readInt32LE(0)).toBe(7);
    expect(versionValues.readInt32LE(4)).toBe(7);
  });

  it('preserves non-ASCII text byte for byte', () => {
    const value = 'مسیر/صفحهٔ محصول · Ürün';
    const file = writeParquet([{ name: 'title', type: 'utf8' }], [{ title: value }]);
    const decoded = decode(file.buffer);
    const { data } = pageOf(file.buffer, decoded.columns[0]);
    expect(readPlainStrings(readDefinitionLevels(data, 1).rest, 1)).toEqual([value]);
  });

  it('handles a column that is null in every row', () => {
    const file = writeParquet([{ name: 'city', type: 'utf8' }], [{ city: null }, { city: null }]);
    const decoded = decode(file.buffer);
    const { data } = pageOf(file.buffer, decoded.columns[0]);
    const { levels, rest } = readDefinitionLevels(data, 2);
    expect(levels).toEqual([0, 0]);
    expect(rest.length).toBe(0);
  });

  it('reports chunk sizes that include the page header, so a reader can walk chunk to chunk', () => {
    const file = writeParquet(COLUMNS, [{ visitor_id: 'v1', title: 'x' }]);
    const decoded = decode(file.buffer);
    for (const column of decoded.columns) {
      const chunkMeta = column['3'] as Record<string, Field>;
      const offset = Number(chunkMeta['9'] as bigint);
      const compressed = Number(chunkMeta['7'] as bigint);
      const reader = new Reader(file.buffer.subarray(offset));
      const header = readStruct(reader);
      expect(compressed).toBe(reader.offset + Number(header['3'] as bigint));
    }
  });

  it('scales to a realistic flush without losing rows', () => {
    const rows = Array.from({ length: 12_000 }, (_, i) => ({
      visitor_id: `visitor-${i % 500}`,
      session_id: `session-${i % 2000}`,
      occurred_at: 1789000000000 + i * 1000,
      schema_version: 1,
      title: i % 5 === 0 ? null : `Page ${i % 40}`,
    }));
    const file = writeParquet(COLUMNS, rows);
    expect(decode(file.buffer).numRows).toBe(12_000);
    // Low-cardinality repeated strings are exactly what ZSTD collapses; if
    // this ever regresses to megabytes, the compression is not being applied.
    expect(file.buffer.length).toBeLessThan(400_000);
  });

  it('refuses to write a file with no columns rather than emitting an unreadable one', () => {
    expect(() => writeParquet([], [{}])).toThrow(/no columns/);
  });
});
