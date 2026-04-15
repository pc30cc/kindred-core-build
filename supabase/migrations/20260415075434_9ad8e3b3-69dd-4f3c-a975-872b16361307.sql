
-- Create accounts table (billing unit)
CREATE TABLE public.accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_id UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create account_members table
CREATE TABLE public.account_members (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (account_id, user_id)
);

-- Add account_id to workspaces
ALTER TABLE public.workspaces ADD COLUMN account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE;

-- Create index for performance
CREATE INDEX idx_account_members_user_id ON public.account_members(user_id);
CREATE INDEX idx_account_members_account_id ON public.account_members(account_id);
CREATE INDEX idx_workspaces_account_id ON public.workspaces(account_id);

-- Enable RLS
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_members ENABLE ROW LEVEL SECURITY;

-- Helper: check if user is account member
CREATE OR REPLACE FUNCTION public.is_account_member(_account_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM account_members WHERE account_id = _account_id AND user_id = _user_id)
$$;

-- Helper: get account role
CREATE OR REPLACE FUNCTION public.get_account_role(_account_id uuid, _user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM account_members WHERE account_id = _account_id AND user_id = _user_id LIMIT 1
$$;

-- RLS for accounts
CREATE POLICY "Members can view their accounts"
ON public.accounts FOR SELECT TO authenticated
USING (is_account_member(id, auth.uid()));

CREATE POLICY "Global admins can view all accounts"
ON public.accounts FOR SELECT TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Owner can update account"
ON public.accounts FOR UPDATE TO authenticated
USING (get_account_role(id, auth.uid()) IN ('owner', 'admin'));

-- RLS for account_members
CREATE POLICY "Members can view account members"
ON public.account_members FOR SELECT TO authenticated
USING (is_account_member(account_id, auth.uid()));

CREATE POLICY "Admins can manage account members"
ON public.account_members FOR ALL TO authenticated
USING (get_account_role(account_id, auth.uid()) IN ('owner', 'admin'))
WITH CHECK (get_account_role(account_id, auth.uid()) IN ('owner', 'admin'));

CREATE POLICY "Global admins can view all account members"
ON public.account_members FOR SELECT TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));

-- Atomic workspace creation RPC
CREATE OR REPLACE FUNCTION public.create_workspace_atomic(
  _account_id uuid,
  _name text,
  _slug text,
  _user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _ws_id uuid;
BEGIN
  -- Verify user is account member
  IF NOT is_account_member(_account_id, _user_id) THEN
    RAISE EXCEPTION 'Not an account member';
  END IF;

  -- Create workspace
  INSERT INTO workspaces (name, slug, owner_id, account_id)
  VALUES (_name, _slug, _user_id, _account_id)
  RETURNING id INTO _ws_id;

  -- Add owner as workspace member
  INSERT INTO workspace_members (workspace_id, user_id, role)
  VALUES (_ws_id, _user_id, 'owner');

  -- Create default branding
  INSERT INTO workspace_branding (workspace_id) VALUES (_ws_id);

  -- Create default widget settings
  INSERT INTO widget_settings (workspace_id) VALUES (_ws_id);

  RETURN _ws_id;
END;
$$;

-- Provision account on signup (called from trigger)
CREATE OR REPLACE FUNCTION public.provision_account_on_signup(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _profile profiles%ROWTYPE;
  _account_id uuid;
  _ws_slug text;
  _ws_name text;
BEGIN
  SELECT * INTO _profile FROM profiles WHERE id = _user_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Determine workspace name
  _ws_name := COALESCE(NULLIF(TRIM(_profile.company_name), ''), COALESCE(_profile.full_name, 'My Workspace'));
  _ws_slug := LOWER(REGEXP_REPLACE(REGEXP_REPLACE(_ws_name, '[^a-zA-Z0-9\s-]', '', 'g'), '\s+', '-', 'g'));
  IF _ws_slug = '' THEN _ws_slug := 'workspace'; END IF;
  -- Ensure unique slug
  _ws_slug := _ws_slug || '-' || SUBSTR(gen_random_uuid()::text, 1, 6);

  -- Create account
  INSERT INTO accounts (name, slug, owner_id)
  VALUES (_ws_name, _ws_slug, _user_id)
  RETURNING id INTO _account_id;

  -- Add user as account owner
  INSERT INTO account_members (account_id, user_id, role)
  VALUES (_account_id, _user_id, 'owner');

  -- Create first workspace atomically
  PERFORM create_workspace_atomic(_account_id, _ws_name, _ws_slug, _user_id);
END;
$$;

-- Update handle_new_user to also provision account
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, company_name, website_domain, main_goal, ai_mode, signup_locale, signup_ip)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.raw_user_meta_data->>'companyName',
    NEW.raw_user_meta_data->>'websiteDomain',
    NEW.raw_user_meta_data->>'mainGoal',
    NEW.raw_user_meta_data->>'aiMode',
    NEW.raw_user_meta_data->>'locale',
    NEW.raw_user_meta_data->>'signup_ip'
  );

  -- Auto-provision account + first workspace
  PERFORM provision_account_on_signup(NEW.id);

  RETURN NEW;
END;
$$;
