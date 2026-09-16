/**
 * What kind of thing an attachment is, for a conversation-list preview.
 *
 * A message whose only content is an attachment has an empty `body`, so a
 * list that previews `body` alone shows "no messages yet" for a conversation
 * that plainly has one. Every list instead describes the media — and there is
 * more than one list (the operator inbox and the visitor widget both build
 * their own), so the mapping lives here rather than being written twice with
 * a chance of disagreeing.
 *
 * The caller turns the kind into a sentence in the READER's language; this
 * function never returns display text.
 */
export type AttachmentPreviewKind = 'image' | 'audio' | 'video' | 'file';

export function attachmentPreviewKind(mimeType: string | null | undefined): AttachmentPreviewKind {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}
