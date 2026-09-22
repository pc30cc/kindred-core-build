import { api } from '@/api/client'

// The bytes behind an attachment stream through the API on the operator's
// token, so an <img> cannot fetch them itself. They are fetched once, kept as
// blob URLs, and shared by every bubble that shows the same file.

const cache = new Map<string, { url: string; data: Uint8Array; mime: string }>()
const inFlight = new Map<string, Promise<{ url: string; data: Uint8Array; mime: string }>>()

export function attachmentBlob(id: string, mime: string): Promise<{ url: string; data: Uint8Array; mime: string }> {
  const hit = cache.get(id)
  if (hit) return Promise.resolve(hit)
  const running = inFlight.get(id)
  if (running) return running
  const task = api
    .attachmentData(id)
    .then((data) => {
      const entry = { url: URL.createObjectURL(new Blob([data as BlobPart], { type: mime || 'application/octet-stream' })), data, mime }
      cache.set(id, entry)
      return entry
    })
    .finally(() => inFlight.delete(id))
  inFlight.set(id, task)
  return task
}
