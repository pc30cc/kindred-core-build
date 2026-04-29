import { createHash } from 'node:crypto';

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function chunkHash(parts: { source_type: string; source_id: string; chunk_index: number; content: string }): string {
  return sha256(`${parts.source_type}|${parts.source_id}|${parts.chunk_index}|${parts.content}`);
}