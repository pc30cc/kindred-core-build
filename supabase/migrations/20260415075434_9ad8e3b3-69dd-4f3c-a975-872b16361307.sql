
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
