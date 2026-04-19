/**
 * Minimal ZIP writer — store-only (no compression, method=0).
 *
 * Why a custom writer:
 *   - The project has no `archiver` / `jszip` dependency installed and the
 *     architecture rule forbids adding hidden runtime weight without
 *     reason.
 *   - Privacy exports are infrequent and bounded in size (per-job).
 *   - Store-only ZIPs are a tiny, well-specified subset of ZIP that any
 *     consumer (Finder, Explorer, unzip, 7-zip) reads correctly.
 *
 * Implements: local file headers + central directory + EOCD.
 * Limit: stays under the 4 GiB / ZIP64 boundary. Each file capped at
 * ~4 GiB. Privacy exports are far smaller than that.
 */

import * as zlib from 'zlib';

interface ZipEntry {
  name: string;
  data: Buffer;
  crc32: number;
  size: number;
  offset: number;
  modTime: number;
  modDate: number;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosTimeDate(d: Date): { time: number; date: number } {
  const time =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    (d.getDate() & 0x1f);
  return { time, date };
}

export class ZipBuilder {
  private entries: ZipEntry[] = [];
  private chunks: Buffer[] = [];
  private offset = 0;

  add(name: string, data: Buffer | string): void {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const now = new Date();
    const { time, date } = dosTimeDate(now);
    const entry: ZipEntry = {
      name,
      data: buf,
      crc32: crc32(buf),
      size: buf.length,
      offset: this.offset,
      modTime: time,
      modDate: date,
    };
    this.entries.push(entry);

    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(entry.crc32, 14);
    local.writeUInt32LE(entry.size, 18); // compressed
    local.writeUInt32LE(entry.size, 22); // uncompressed
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    this.chunks.push(local, nameBuf, buf);
    this.offset += local.length + nameBuf.length + buf.length;
  }

  build(): Buffer {
    const cdChunks: Buffer[] = [];
    let cdSize = 0;
    for (const e of this.entries) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); // central dir signature
      cd.writeUInt16LE(20, 4); // version made by
      cd.writeUInt16LE(20, 6); // version needed
      cd.writeUInt16LE(0x0800, 8); // flags: UTF-8
      cd.writeUInt16LE(0, 10); // method
      cd.writeUInt16LE(e.modTime, 12);
      cd.writeUInt16LE(e.modDate, 14);
      cd.writeUInt32LE(e.crc32, 16);
      cd.writeUInt32LE(e.size, 20);
      cd.writeUInt32LE(e.size, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt16LE(0, 30); // extra
      cd.writeUInt16LE(0, 32); // comment
      cd.writeUInt16LE(0, 34); // disk number
      cd.writeUInt16LE(0, 36); // internal attrs
      cd.writeUInt32LE(0, 38); // external attrs
      cd.writeUInt32LE(e.offset, 42);
      cdChunks.push(cd, nameBuf);
      cdSize += cd.length + nameBuf.length;
    }

    const cdOffset = this.offset;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4); // disk
    eocd.writeUInt16LE(0, 6); // disk with cd
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20); // comment length

    return Buffer.concat([...this.chunks, ...cdChunks, eocd]);
  }
}

// Re-export zlib for callers that want optional gzip of internal JSON.
export { zlib };