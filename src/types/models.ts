// Core data models

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  preferred_locale: string | null;
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  default_locale: string;
  panel_locale: string;
  widget_locale: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'agent' | 'viewer';
  created_at: string;
}

export interface WorkspaceDomain {
  id: string;
  workspace_id: string;
  domain: string;
  verified: boolean;
  is_primary: boolean;
  created_at: string;
}

export interface WorkspaceBranding {
  id: string;
  workspace_id: string;
  platform_name: string;
  short_name: string;
  logo_url: string | null;
  favicon_url: string | null;
  primary_color: string;
  accent_color: string;
  support_email: string | null;
  sender_name: string | null;
  meta_title: string | null;
  meta_description: string | null;
  social_image_url: string | null;
  footer_text: string | null;
  legal_name: string | null;
  canonical_base_url: string | null;
  panel_base_url: string | null;
  widget_base_url: string | null;
  asset_base_url: string | null;
}

export interface Contact {
  id: string;
  workspace_id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  avatar_url: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  workspace_id: string;
  contact_id: string | null;
  visitor_session_id: string | null;
  subject: string | null;
  status: 'open' | 'pending' | 'resolved' | 'closed';
  assigned_to: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  sender_type: 'agent' | 'contact' | 'system' | 'bot';
  sender_id: string | null;
  body: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface VisitorSession {
  id: string;
  workspace_id: string;
  visitor_id: string;
  current_page: string | null;
  referrer: string | null;
  browser: string | null;
  device: string | null;
  os: string | null;
  country: string | null;
  city: string | null;
  ip_hash: string | null;
  started_at: string;
  last_seen_at: string;
}

export interface VisitorPresence {
  id: string;
  workspace_id: string;
  visitor_session_id: string;
  status: 'online' | 'idle' | 'offline';
  current_page: string | null;
  updated_at: string;
}

export interface WidgetSettings {
  id: string;
  workspace_id: string;
  enabled: boolean;
  primary_color: string;
  launcher_text: string | null;
  welcome_message: string | null;
  logo_url: string | null;
  position: 'bottom-right' | 'bottom-left';
  allowed_domains: string[];
  chat_enabled: boolean;
  kb_enabled: boolean;
  visitor_tracking_enabled: boolean;
  locale: string;
}

export interface KnowledgeBaseArticle {
  id: string;
  workspace_id: string;
  category_id: string | null;
  slug: string;
  locale: string;
  title: string;
  content: string;
  excerpt: string | null;
  status: 'draft' | 'published' | 'archived';
  order: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeBaseCategory {
  id: string;
  workspace_id: string;
  slug: string;
  locale: string;
  name: string;
  description: string | null;
  icon: string | null;
  order: number;
  created_at: string;
}

export interface ProviderConfig {
  id: string;
  workspace_id: string;
  provider_type: string; // 'auth' | 'email' | 'ai' | 'storage' | 'search' | 'notification' | 'cache'
  provider_name: string;
  config: Record<string, unknown>; // encrypted at rest
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Translation {
  id: string;
  workspace_id: string | null;
  locale: string;
  namespace: string;
  key: string;
  value: string;
}

export interface AuditLog {
  id: string;
  workspace_id: string;
  user_id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

export interface FeatureFlag {
  id: string;
  workspace_id: string | null;
  key: string;
  enabled: boolean;
  description: string | null;
}

export interface EmailTemplate {
  id: string;
  workspace_id: string;
  slug: string;
  locale: string;
  subject: string;
  html_body: string;
  text_body: string | null;
}
