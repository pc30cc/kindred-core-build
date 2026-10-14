-- Run ONLY against the dedicated Widget Bridge database, never either app DB.
-- No foreign keys, triggers or migrations are added to WebYar/RESPOK.
BEGIN;
CREATE TABLE IF NOT EXISTS widget_bridge_settings (
  app_id text NOT NULL,
  owner_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  deleting boolean NOT NULL DEFAULT false,
  identity jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, owner_id, workspace_id)
);
CREATE TABLE IF NOT EXISTS widget_bridge_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id text NOT NULL,
  owner_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  url text NOT NULL CHECK (length(url) <= 2048),
  provider text NOT NULL DEFAULT 'auto',
  selectors jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT false,
  deleting boolean NOT NULL DEFAULT false,
  generation integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'idle',
  last_error text,
  session_envelope jsonb,
  lease_owner uuid,
  lease_until timestamptz,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, owner_id, workspace_id, url),
  FOREIGN KEY (app_id, owner_id, workspace_id)
    REFERENCES widget_bridge_settings (app_id, owner_id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS widget_bridge_contacts_scope
  ON widget_bridge_contacts (app_id, owner_id, workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS widget_bridge_contacts_poll
  ON widget_bridge_contacts (next_poll_at) WHERE enabled AND NOT deleting;
CREATE INDEX IF NOT EXISTS widget_bridge_contacts_cleanup
  ON widget_bridge_contacts (lease_until) WHERE deleting;
CREATE TABLE IF NOT EXISTS widget_bridge_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES widget_bridge_contacts(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  delivery text NOT NULL CHECK (delivery IN ('queued','preparing','dispatching','sent','received','failed','uncertain','cancelled')),
  dedupe_key text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, direction, dedupe_key)
);
CREATE INDEX IF NOT EXISTS widget_bridge_messages_thread
  ON widget_bridge_messages (contact_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS widget_bridge_messages_outbox
  ON widget_bridge_messages (contact_id, created_at) WHERE delivery = 'queued';
-- Access is backend/worker only. No authenticated/anon browser role grants.
ALTER TABLE widget_bridge_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE widget_bridge_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE widget_bridge_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON widget_bridge_settings, widget_bridge_contacts, widget_bridge_messages FROM PUBLIC;
COMMIT;
