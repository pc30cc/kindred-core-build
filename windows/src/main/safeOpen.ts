import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { shell } from 'electron'
import type { OpenFileWithResult } from '../shared/ipc'

// Attachments come from visitors, so whatever they name a file is untrusted.
// "Open" hands the file to Windows' default handler, which for an .exe, .bat,
// .js, .hta, .lnk, .docm … means running it. Only types whose default handler
// just shows the content are opened; everything else goes through "Save as".
// These checks live in the main process on purpose: the renderer is not trusted.

/** Opened as-is: viewers that do not run code from the file. */
const PASSIVE = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic',
  'pdf', 'txt',
  'mp3', 'wav', 'ogg', 'm4a', 'mp4', 'webm', 'mov',
])

/**
 * Opened only when the file carries the Mark of the Web, so Office shows it in
 * Protected View (macro-free formats only; .docm/.xlsm/… are never opened).
 */
const NEEDS_MOTW = new Set(['docx', 'xlsx', 'pptx', 'csv'])

const ZONE_IDENTIFIER = '[ZoneTransfer]\r\nZoneId=3\r\n'

/**
 * Tags a file as downloaded from the internet (NTFS alternate data stream), the
 * same as a browser does, so SmartScreen / Protected View apply. Best effort:
 * returns false when it could not be written (not Windows, not NTFS, …).
 */
export function markFromInternet(path: string): boolean {
  if (process.platform !== 'win32') return false
  try {
    writeFileSync(`${path}:Zone.Identifier`, ZONE_IDENTIFIER)
    return true
  } catch {
    return false
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** A file name Windows will store exactly as given: no folders, streams or tricks. */
export function safeFileName(name: string): string {
  const last = String(name ?? '').split(/[\\/]/).pop() ?? ''
  let safe = last
    // Reserved characters (':' would name an alternate data stream) and control characters.
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    // Bidi controls let "evil‮fdp.exe" look like "evilexe.pdf".
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    // Windows drops trailing dots and spaces, so "a.exe." would really be "a.exe".
    .replace(/[. ]+$/, '')
    .trim()
  if (!safe || WINDOWS_RESERVED.test(safe)) safe = `file${safe ? `_${safe}` : ''}`
  return safe.slice(-180)
}

let tempRoot: string | null = null

/** One private, randomly named folder per app run, and a fresh sub-folder per file. */
async function tempPathFor(name: string): Promise<string> {
  if (!tempRoot) tempRoot = mkdtempSync(join(tmpdir(), 'webyar-'))
  const dir = join(tempRoot, randomUUID())
  await mkdir(dir, { recursive: true })
  return join(dir, name)
}

export async function openAttachment(fileName: string, data: Uint8Array): Promise<OpenFileWithResult> {
  const name = safeFileName(fileName)
  const ext = extname(name).slice(1).toLowerCase()
  const passive = PASSIVE.has(ext)
  if (!passive && !NEEDS_MOTW.has(ext)) return 'unsafe'
  const path = await tempPathFor(name)
  await writeFile(path, Buffer.from(data))
  const marked = markFromInternet(path)
  if (!passive && !marked) return 'unsafe'
  const error = await shell.openPath(path)
  return error === '' ? 'opened' : 'failed'
}
