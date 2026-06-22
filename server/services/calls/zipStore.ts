/**
 * Minimal STORE-only ZIP builder.
 *
 * Used exclusively by the read-only recording archive export surface
 * (operator-scoped, single-call). Recordings are already-compressed
 * media (mp4/mp3/m4a/ogg/webm), so the DEFLATE method would not
 * meaningfully reduce size — STORE keeps memory bounded and avoids
 * pulling in a third-party archive dependency.
 *
 * Output is a single Buffer to keep the surface trivially testable and
 * to make the response Content-Length honest. The caller enforces a
 * hard total-bytes cap before invoking this helper.
 *
 * This module is intentionally read-only — it never touches storage or
 * the database.
 */

const CRC_TABLE: number[] = (() => {
  const t: number[] = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS time/date encoding for the ZIP local/central headers. We always emit a
// stable, UTC epoch so archive bytes are deterministic for tests.
function dosTime(d: Date): { time: number; date: number } {
  const time = ((d.getUTCHours() & 0x1f) << 11) | ((d.getUTCMinutes() & 0x3f) << 5) | ((Math.floor(d.getUTCSeconds() / 2)) & 0x1f);
  const date = (((d.getUTCFullYear() - 1980) & 0x7f) << 9) | (((d.getUTCMonth() + 1) & 0xf) << 5) | (d.getUTCDate() & 0x1f);
  return { time, date };
}

export interface ZipEntry {
  /** Name inside the archive. Forward-slashes, no leading slash. */
  name: string;
  data: Buffer;
  /** Optional mtime; defaults to now. */
  mtime?: Date;
}

/**
 * Build a STORE-only ZIP archive from the given entries. Names are encoded
 * as UTF-8 (bit 11 of general purpose flag set) so non-ASCII filenames are
 * preserved by spec-compliant unzippers.
 */
export function buildStoreZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const size = data.length;
    const { time, date } = dosTime(entry.mtime ?? new Date());

    // Local file header (30 bytes + name)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);  // signature
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // general purpose flag (UTF-8 names)
    local.writeUInt16LE(0, 8);           // method = STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);       // compressed size
    local.writeUInt32LE(size, 22);       // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra field length

    localParts.push(local, nameBuf, data);
    const localHeaderOffset = offset;
    offset += local.length + nameBuf.length + data.length;

    // Central directory header (46 bytes + name)
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);    // general purpose flag (UTF-8)
    central.writeUInt16LE(0, 10);        // method = STORE
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk number
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(localHeaderOffset, 42);

    centralParts.push(central, nameBuf);
  }

  const centralBuf = Buffer.concat(centralParts);
  const centralOffset = offset;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);                       // disk number
  end.writeUInt16LE(0, 6);                       // disk where CD starts
  end.writeUInt16LE(entries.length, 8);          // entries on this disk
  end.writeUInt16LE(entries.length, 10);         // total entries
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);                      // comment length

  return Buffer.concat([...localParts, centralBuf, end]);
}

/**
 * Sanitize a per-entry filename so we never write absolute paths or
 * path-traversal sequences into the archive. Returns a safe basename.
 */
export function safeArchiveName(raw: string, fallback: string): string {
  const trimmed = String(raw || '').replace(/\\/g, '/').split('/').pop() || '';
  const cleaned = trimmed.replace(/[\x00-\x1f"*:<>?|]/g, '_').replace(/^\.+/, '').trim();
  return cleaned || fallback;
}