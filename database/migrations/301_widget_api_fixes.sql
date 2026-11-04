-- 301 — Widget API fixes (audit of 2026-11-04, widgetapi-5).
--
-- conversation_attachments.uploaded_by_visitor_id: the signed visitor (the
-- dvsid cookie or the visitor credential, never a body id) who reserved a
-- widget upload at POST /api/widget/attachments/init. A file no conversation
-- holds yet (status 'uploading' or 'uploaded', conversation_id NULL) is
-- then only that visitor's: to upload its bytes into, to attach to their
-- message (attachUploadedFileToMessage) and to download
-- (GET /api/widget/attachments/:id). Before it, any widget token of the
-- workspace could do all three with a file's id, including operators'
-- team-chat files, which are stored with conversation_id NULL
-- (server/routes/widgetAttachments.ts, UPLOADER_COLUMN).
--
-- text, not uuid: the cookie's visitor id is a uuid today, but the column
-- only ever compares it with the signed id, and a text column never refuses
-- an insert. Nullable, no default: operators' rows (uploaded_by_type
-- 'agent') and the widget's rows written before it stay NULL, which the
-- server reads as "nobody's" for an unbound file (an old unbound visitor
-- upload can no longer be attached; the widget uploads right before it
-- sends, so none is waiting).
--
-- It writes no data and takes no lock beyond ADD COLUMN's brief ACCESS
-- EXCLUSIVE (a nullable column without a default rewrites nothing). Before
-- it, the server falls back to the columns it had (lib/missingColumn.ts):
-- uploads keep working, an unbound file is served to nobody.
--
-- Rollout: applied by hand on WebYar BEFORE the merge of the code that uses
-- it (CLAUDE.md, Migrations), after a dry run inside BEGIN … ROLLBACK; by its
-- migrator on RESPOK, on push. Re-runnable: a second run finds the column
-- and changes nothing. Way back: the column can stay (nothing else reads
-- it); `ALTER TABLE public.conversation_attachments DROP COLUMN
-- uploaded_by_visitor_id` only after the code that writes it is gone.

ALTER TABLE public.conversation_attachments
  ADD COLUMN IF NOT EXISTS uploaded_by_visitor_id text;

COMMENT ON COLUMN public.conversation_attachments.uploaded_by_visitor_id IS
  'The signed widget visitor who reserved this upload (POST /api/widget/attachments/init); NULL for operators'' files and rows written before migration 301. An unbound file is only its uploader''s (server/routes/widgetAttachments.ts).';
