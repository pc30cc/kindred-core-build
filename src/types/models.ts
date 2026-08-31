// Core data models

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  preferred_locale: string | null;
  company_name: string | null;
  website_domain: string | null;
  main_goal: string | null;
  ai_mode: string | null;
  signup_locale: string | null;
  signup_ip: string | null;
  created_at: string;
  updated_at: string;
}

export interface Account {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface AccountMember {
  id: string;
  account_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  created_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  account_id: string | null;
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
  widget_public_base_url: string | null;
  widget_loader_base_url: string | null;
  widget_api_base_url: string | null;
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
  /** Stable anonymous display code — see src/lib/contact-display.ts. */
  visitor_code?: string | null;
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
  // Mirrors the DB enum public.sender_type. 'ai' = AI auto-reply,
  // distinct from 'agent' (human operator) and 'bot' (legacy generic bot).
  sender_type: 'agent' | 'contact' | 'system' | 'bot' | 'ai';
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
  /** Reply-time note under the workspace name in the widget header. */
  reply_time_text: string | null;
  /** Widget header display name; empty => workspace name. */
  brand_name: string | null;
  /** Optional widget panel shadow tint; empty => template default. */
  shadow_color: string | null;

  logo_url: string | null;
  position: 'bottom-right' | 'bottom-left';
  allowed_domains: string[];
  allow_subdomains: boolean;
  chat_enabled: boolean;
  kb_enabled: boolean;
  visitor_tracking_enabled: boolean;
  locale: string;
  debug_mode: boolean;
  // Phase 8 — Availability
  live_chat_enabled: boolean;
  offline_mode: 'hide_widget' | 'show_offline_message' | 'capture_message';
  offline_message: string | null;
  offline_message_localized: Record<string, string> | null;
  availability_labels: Record<string, { online?: string; offline?: string }> | null;
  business_hours: BusinessHoursConfig | null;
}

export interface BusinessHoursConfig {
  enabled: boolean;
  timezone: string;
  weekly: Partial<Record<'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat', Array<{ from: string; to: string }>>>;
  overrides?: Array<{ date: string; closed?: boolean; intervals?: Array<{ from: string; to: string }>; label?: string }>;
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
  /**
   * KB unification — Phase 2 visibility flags.
   * - visible_in_widget: include this article in the public help-center / widget.
   * - used_by_ai: allow the AI Agent to use this article as a retrieval source.
   * Both default to true server-side so existing articles keep their behavior.
   */
  visible_in_widget: boolean;
  used_by_ai: boolean;
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
