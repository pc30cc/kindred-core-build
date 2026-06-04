CREATE UNIQUE INDEX IF NOT EXISTS contacts_workspace_email_unique_not_blank
ON public.contacts (workspace_id, lower(btrim(email)))
WHERE email IS NOT NULL AND btrim(email) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS contacts_workspace_phone_unique_not_blank
ON public.contacts (workspace_id, regexp_replace(phone, '[^0-9+]', '', 'g'))
WHERE phone IS NOT NULL AND regexp_replace(phone, '[^0-9+]', '', 'g') <> '';