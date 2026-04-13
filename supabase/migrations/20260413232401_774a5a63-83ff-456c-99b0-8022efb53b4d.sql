
CREATE TABLE IF NOT EXISTS billing_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  sort_order integer DEFAULT 0,
  prices jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_currency text NOT NULL DEFAULT 'USD',
  entitlements jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_price_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean DEFAULT true,
  is_free boolean DEFAULT false,
  trial_days integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE UNIQUE,
  plan_id uuid REFERENCES billing_plans(id),
  provider_name text NOT NULL DEFAULT 'manual',
  provider_subscription_id text,
  provider_customer_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('trialing','active','past_due','canceled','unpaid','expired','incomplete','paused')),
  cancel_at_period_end boolean DEFAULT false,
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_end timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_name text NOT NULL,
  provider_payment_id text,
  amount integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','refunded','partially_refunded')),
  refund_amount integer,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  event_type text NOT NULL,
  provider_name text NOT NULL,
  provider_event_id text,
  amount integer,
  currency text,
  status text NOT NULL DEFAULT 'received',
  metadata jsonb DEFAULT '{}'::jsonb,
  processed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_events_idempotent ON billing_events (provider_name, provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ws_subs_workspace ON workspace_subscriptions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_billing_payments_workspace ON billing_payments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_workspace ON billing_events(workspace_id);

ALTER TABLE billing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read active plans" ON billing_plans FOR SELECT TO anon USING (is_active = true);
CREATE POLICY "Authenticated can read plans" ON billing_plans FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage plans" ON billing_plans FOR ALL TO authenticated USING (has_role(auth.uid(), 'admin')) WITH CHECK (has_role(auth.uid(), 'admin'));

CREATE POLICY "Members can view subscription" ON workspace_subscriptions FOR SELECT TO authenticated USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Admins can manage all subscriptions" ON workspace_subscriptions FOR ALL TO authenticated USING (has_role(auth.uid(), 'admin')) WITH CHECK (has_role(auth.uid(), 'admin'));

CREATE POLICY "Workspace admins can view payments" ON billing_payments FOR SELECT TO authenticated USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));
CREATE POLICY "Global admins can view all payments" ON billing_payments FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can view billing events" ON billing_events FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'));

INSERT INTO billing_plans (name, slug, description, sort_order, is_free, prices, default_currency, entitlements, limits) VALUES
('Free', 'free', 'Get started with basic features', 0, true, '{"USD":{"monthly":0,"yearly":0},"EUR":{"monthly":0,"yearly":0},"IRR":{"monthly":0,"yearly":0},"TRY":{"monthly":0,"yearly":0}}', 'USD', '{"ai_enabled":false,"custom_branding":false,"advanced_analytics":false,"priority_support":false}', '{"team_members":2,"ai_requests_monthly":0,"storage_mb":100,"kb_articles":10,"contacts":100,"conversations_monthly":50}'),
('Pro', 'pro', 'For growing teams', 1, false, '{"USD":{"monthly":2900,"yearly":29000},"EUR":{"monthly":2700,"yearly":27000},"IRR":{"monthly":15000000,"yearly":150000000},"TRY":{"monthly":99900,"yearly":999000}}', 'USD', '{"ai_enabled":true,"custom_branding":true,"advanced_analytics":true,"priority_support":false}', '{"team_members":10,"ai_requests_monthly":5000,"storage_mb":5000,"kb_articles":100,"contacts":5000,"conversations_monthly":1000}'),
('Enterprise', 'enterprise', 'For large organizations', 2, false, '{"USD":{"monthly":9900,"yearly":99000},"EUR":{"monthly":9200,"yearly":92000},"IRR":{"monthly":50000000,"yearly":500000000},"TRY":{"monthly":349900,"yearly":3499000}}', 'USD', '{"ai_enabled":true,"custom_branding":true,"advanced_analytics":true,"priority_support":true,"sso":true,"audit_logs":true,"api_access":true}', '{"team_members":-1,"ai_requests_monthly":-1,"storage_mb":50000,"kb_articles":-1,"contacts":-1,"conversations_monthly":-1}')
ON CONFLICT (slug) DO NOTHING;
