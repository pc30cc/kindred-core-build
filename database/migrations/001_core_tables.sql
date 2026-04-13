-- Migration: 001_core_tables.sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Profiles
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  avatar_url TEXT,
  preferred_locale TEXT DEFAULT 'en',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

CREATE OR REPLACE FUNCTION handle_new_user() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name) VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', ''));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- User roles
CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');
CREATE TABLE IF NOT EXISTS user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL,
  UNIQUE (user_id, role)
);
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

-- Workspaces
CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  default_locale TEXT DEFAULT 'en',
  panel_locale TEXT DEFAULT 'en',
  widget_locale TEXT DEFAULT 'en',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

-- Workspace members
CREATE TYPE public.workspace_role AS ENUM ('owner', 'admin', 'agent', 'viewer');
CREATE TABLE IF NOT EXISTS workspace_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role workspace_role NOT NULL DEFAULT 'agent',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION is_workspace_member(_workspace_id UUID, _user_id UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = _workspace_id AND user_id = _user_id)
$$;
CREATE OR REPLACE FUNCTION get_workspace_role(_workspace_id UUID, _user_id UUID) RETURNS workspace_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM workspace_members WHERE workspace_id = _workspace_id AND user_id = _user_id LIMIT 1
$$;

CREATE POLICY "Members can view workspace" ON workspaces FOR SELECT TO authenticated USING (is_workspace_member(id, auth.uid()));
CREATE POLICY "Owners can update workspace" ON workspaces FOR UPDATE TO authenticated USING (owner_id = auth.uid());
CREATE POLICY "Authenticated can create workspace" ON workspaces FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY "Members can view members" ON workspace_members FOR SELECT TO authenticated USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Admins+ can insert members" ON workspace_members FOR INSERT TO authenticated WITH CHECK (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));
CREATE POLICY "Admins+ can delete members" ON workspace_members FOR DELETE TO authenticated USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));
