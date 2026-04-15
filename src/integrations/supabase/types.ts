export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_members: {
        Row: {
          account_id: string
          created_at: string
          id: string
          role: string
          user_id: string
        }
        Insert: {
          account_id: string
          created_at?: string
          id?: string
          role?: string
          user_id: string
        }
        Update: {
          account_id?: string
          created_at?: string
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_members_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      accounts: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_id: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          owner_id: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_id?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      ai_usage_logs: {
        Row: {
          completion_tokens: number | null
          created_at: string | null
          endpoint: string | null
          error_message: string | null
          id: string
          latency_ms: number | null
          metadata: Json | null
          model: string | null
          prompt_tokens: number | null
          provider_name: string
          success: boolean
          total_tokens: number | null
          workspace_id: string
        }
        Insert: {
          completion_tokens?: number | null
          created_at?: string | null
          endpoint?: string | null
          error_message?: string | null
          id?: string
          latency_ms?: number | null
          metadata?: Json | null
          model?: string | null
          prompt_tokens?: number | null
          provider_name: string
          success?: boolean
          total_tokens?: number | null
          workspace_id: string
        }
        Update: {
          completion_tokens?: number | null
          created_at?: string | null
          endpoint?: string | null
          error_message?: string | null
          id?: string
          latency_ms?: number | null
          metadata?: Json | null
          model?: string | null
          prompt_tokens?: number | null
          provider_name?: string
          success?: boolean
          total_tokens?: number | null
          workspace_id?: string
        }
        Relationships: []
      }
      app_runtime_config: {
        Row: {
          key: string
          updated_at: string | null
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string | null
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string | null
          value?: Json
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          created_at: string | null
          entity_id: string | null
          entity_type: string
          id: string
          ip_address: string | null
          new_value: Json | null
          old_value: Json | null
          user_id: string
          workspace_id: string
        }
        Insert: {
          action: string
          created_at?: string | null
          entity_id?: string | null
          entity_type: string
          id?: string
          ip_address?: string | null
          new_value?: Json | null
          old_value?: Json | null
          user_id: string
          workspace_id: string
        }
        Update: {
          action?: string
          created_at?: string | null
          entity_id?: string | null
          entity_type?: string
          id?: string
          ip_address?: string | null
          new_value?: Json | null
          old_value?: Json | null
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      auth_reset_tokens: {
        Row: {
          created_at: string
          email: string
          expires_at: string
          id: string
          ip_address: string | null
          revoked_at: string | null
          token_hash: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          expires_at: string
          id?: string
          ip_address?: string | null
          revoked_at?: string | null
          token_hash: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          ip_address?: string | null
          revoked_at?: string | null
          token_hash?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      auth_sessions: {
        Row: {
          created_at: string
          email: string
          expires_at: string
          id: string
          ip_address: string | null
          revoked_at: string | null
          token_hash: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          expires_at: string
          id?: string
          ip_address?: string | null
          revoked_at?: string | null
          token_hash: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          ip_address?: string | null
          revoked_at?: string | null
          token_hash?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      auth_verify_tokens: {
        Row: {
          created_at: string
          email: string
          expires_at: string
          id: string
          ip_address: string | null
          revoked_at: string | null
          token_hash: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          expires_at: string
          id?: string
          ip_address?: string | null
          revoked_at?: string | null
          token_hash: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          ip_address?: string | null
          revoked_at?: string | null
          token_hash?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      billing_events: {
        Row: {
          amount: number | null
          created_at: string | null
          currency: string | null
          event_type: string
          id: string
          metadata: Json | null
          processed_at: string | null
          provider_event_id: string | null
          provider_name: string
          status: string
          workspace_id: string
        }
        Insert: {
          amount?: number | null
          created_at?: string | null
          currency?: string | null
          event_type: string
          id?: string
          metadata?: Json | null
          processed_at?: string | null
          provider_event_id?: string | null
          provider_name: string
          status?: string
          workspace_id: string
        }
        Update: {
          amount?: number | null
          created_at?: string | null
          currency?: string | null
          event_type?: string
          id?: string
          metadata?: Json | null
          processed_at?: string | null
          provider_event_id?: string | null
          provider_name?: string
          status?: string
          workspace_id?: string
        }
        Relationships: []
      }
      billing_payments: {
        Row: {
          amount: number
          created_at: string | null
          currency: string
          id: string
          metadata: Json | null
          provider_name: string
          provider_payment_id: string | null
          refund_amount: number | null
          status: string
          workspace_id: string
        }
        Insert: {
          amount?: number
          created_at?: string | null
          currency?: string
          id?: string
          metadata?: Json | null
          provider_name: string
          provider_payment_id?: string | null
          refund_amount?: number | null
          status?: string
          workspace_id: string
        }
        Update: {
          amount?: number
          created_at?: string | null
          currency?: string
          id?: string
          metadata?: Json | null
          provider_name?: string
          provider_payment_id?: string | null
          refund_amount?: number | null
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_payments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_plans: {
        Row: {
          created_at: string | null
          default_currency: string
          description: string | null
          entitlements: Json
          id: string
          is_active: boolean | null
          is_free: boolean | null
          limits: Json
          localized: Json
          name: string
          prices: Json
          provider_price_ids: Json
          slug: string
          sort_order: number | null
          trial_days: number | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          default_currency?: string
          description?: string | null
          entitlements?: Json
          id?: string
          is_active?: boolean | null
          is_free?: boolean | null
          limits?: Json
          localized?: Json
          name: string
          prices?: Json
          provider_price_ids?: Json
          slug: string
          sort_order?: number | null
          trial_days?: number | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          default_currency?: string
          description?: string | null
          entitlements?: Json
          id?: string
          is_active?: boolean | null
          is_free?: boolean | null
          limits?: Json
          localized?: Json
          name?: string
          prices?: Json
          provider_price_ids?: Json
          slug?: string
          sort_order?: number | null
          trial_days?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      contacts: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          email: string | null
          id: string
          metadata: Json | null
          name: string | null
          notes: string | null
          phone: string | null
          tags: string[] | null
          updated_at: string | null
          workspace_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          metadata?: Json | null
          name?: string | null
          notes?: string | null
          phone?: string | null
          tags?: string[] | null
          updated_at?: string | null
          workspace_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          metadata?: Json | null
          name?: string | null
          notes?: string | null
          phone?: string | null
          tags?: string[] | null
          updated_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_messages: {
        Row: {
          body: string
          conversation_id: string
          created_at: string | null
          id: string
          metadata: Json | null
          sender_id: string | null
          sender_type: Database["public"]["Enums"]["sender_type"]
        }
        Insert: {
          body: string
          conversation_id: string
          created_at?: string | null
          id?: string
          metadata?: Json | null
          sender_id?: string | null
          sender_type: Database["public"]["Enums"]["sender_type"]
        }
        Update: {
          body?: string
          conversation_id?: string
          created_at?: string | null
          id?: string
          metadata?: Json | null
          sender_id?: string | null
          sender_type?: Database["public"]["Enums"]["sender_type"]
        }
        Relationships: [
          {
            foreignKeyName: "conversation_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          assigned_to: string | null
          contact_id: string | null
          created_at: string | null
          id: string
          priority: Database["public"]["Enums"]["conversation_priority"] | null
          status: Database["public"]["Enums"]["conversation_status"] | null
          subject: string | null
          tags: string[] | null
          updated_at: string | null
          visitor_session_id: string | null
          workspace_id: string
        }
        Insert: {
          assigned_to?: string | null
          contact_id?: string | null
          created_at?: string | null
          id?: string
          priority?: Database["public"]["Enums"]["conversation_priority"] | null
          status?: Database["public"]["Enums"]["conversation_status"] | null
          subject?: string | null
          tags?: string[] | null
          updated_at?: string | null
          visitor_session_id?: string | null
          workspace_id: string
        }
        Update: {
          assigned_to?: string | null
          contact_id?: string | null
          created_at?: string | null
          id?: string
          priority?: Database["public"]["Enums"]["conversation_priority"] | null
          status?: Database["public"]["Enums"]["conversation_status"] | null
          subject?: string | null
          tags?: string[] | null
          updated_at?: string | null
          visitor_session_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      email_logs: {
        Row: {
          created_at: string | null
          error_message: string | null
          id: string
          metadata: Json | null
          provider_name: string | null
          recipient_email: string
          sent_at: string | null
          status: string
          subject: string | null
          template_slug: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string | null
          error_message?: string | null
          id?: string
          metadata?: Json | null
          provider_name?: string | null
          recipient_email: string
          sent_at?: string | null
          status?: string
          subject?: string | null
          template_slug?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string | null
          error_message?: string | null
          id?: string
          metadata?: Json | null
          provider_name?: string | null
          recipient_email?: string
          sent_at?: string | null
          status?: string
          subject?: string | null
          template_slug?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_logs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      email_settings: {
        Row: {
          created_at: string | null
          email_footer_text: string | null
          email_logo_url: string | null
          id: string
          reply_to_email: string | null
          sender_email: string | null
          updated_at: string | null
          workspace_id: string | null
        }
        Insert: {
          created_at?: string | null
          email_footer_text?: string | null
          email_logo_url?: string | null
          id?: string
          reply_to_email?: string | null
          sender_email?: string | null
          updated_at?: string | null
          workspace_id?: string | null
        }
        Update: {
          created_at?: string | null
          email_footer_text?: string | null
          email_logo_url?: string | null
          id?: string
          reply_to_email?: string | null
          sender_email?: string | null
          updated_at?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      email_settings_localized: {
        Row: {
          created_at: string | null
          footer_text: string | null
          id: string
          locale: string
          sender_name: string | null
          support_contact_label: string | null
          updated_at: string | null
          workspace_id: string | null
        }
        Insert: {
          created_at?: string | null
          footer_text?: string | null
          id?: string
          locale: string
          sender_name?: string | null
          support_contact_label?: string | null
          updated_at?: string | null
          workspace_id?: string | null
        }
        Update: {
          created_at?: string | null
          footer_text?: string | null
          id?: string
          locale?: string
          sender_name?: string | null
          support_contact_label?: string | null
          updated_at?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_settings_localized_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      email_templates: {
        Row: {
          html_body: string
          id: string
          is_active: boolean | null
          locale: string
          slug: string
          subject: string
          text_body: string | null
          workspace_id: string | null
        }
        Insert: {
          html_body: string
          id?: string
          is_active?: boolean | null
          locale?: string
          slug: string
          subject: string
          text_body?: string | null
          workspace_id?: string | null
        }
        Update: {
          html_body?: string
          id?: string
          is_active?: boolean | null
          locale?: string
          slug?: string
          subject?: string
          text_body?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_templates_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_flags: {
        Row: {
          description: string | null
          enabled: boolean | null
          id: string
          key: string
          workspace_id: string | null
        }
        Insert: {
          description?: string | null
          enabled?: boolean | null
          id?: string
          key: string
          workspace_id?: string | null
        }
        Update: {
          description?: string | null
          enabled?: boolean | null
          id?: string
          key?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "feature_flags_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ip_blocklist: {
        Row: {
          blocked_by: string | null
          blocked_until: string | null
          created_at: string | null
          id: string
          ip_address: string
          reason: string
        }
        Insert: {
          blocked_by?: string | null
          blocked_until?: string | null
          created_at?: string | null
          id?: string
          ip_address: string
          reason: string
        }
        Update: {
          blocked_by?: string | null
          blocked_until?: string | null
          created_at?: string | null
          id?: string
          ip_address?: string
          reason?: string
        }
        Relationships: []
      }
      knowledge_base_articles: {
        Row: {
          category_id: string | null
          content: string
          created_at: string | null
          excerpt: string | null
          id: string
          locale: string
          slug: string
          sort_order: number | null
          status: Database["public"]["Enums"]["article_status"] | null
          title: string
          updated_at: string | null
          workspace_id: string
        }
        Insert: {
          category_id?: string | null
          content?: string
          created_at?: string | null
          excerpt?: string | null
          id?: string
          locale?: string
          slug: string
          sort_order?: number | null
          status?: Database["public"]["Enums"]["article_status"] | null
          title: string
          updated_at?: string | null
          workspace_id: string
        }
        Update: {
          category_id?: string | null
          content?: string
          created_at?: string | null
          excerpt?: string | null
          id?: string
          locale?: string
          slug?: string
          sort_order?: number | null
          status?: Database["public"]["Enums"]["article_status"] | null
          title?: string
          updated_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_base_articles_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "knowledge_base_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_base_articles_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_base_categories: {
        Row: {
          created_at: string | null
          description: string | null
          icon: string | null
          id: string
          locale: string
          name: string
          slug: string
          sort_order: number | null
          workspace_id: string
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          icon?: string | null
          id?: string
          locale?: string
          name: string
          slug: string
          sort_order?: number | null
          workspace_id: string
        }
        Update: {
          created_at?: string | null
          description?: string | null
          icon?: string | null
          id?: string
          locale?: string
          name?: string
          slug?: string
          sort_order?: number | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_base_categories_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      login_attempts: {
        Row: {
          created_at: string | null
          email: string
          id: string
          ip_address: string
          success: boolean
        }
        Insert: {
          created_at?: string | null
          email: string
          id?: string
          ip_address: string
          success?: boolean
        }
        Update: {
          created_at?: string | null
          email?: string
          id?: string
          ip_address?: string
          success?: boolean
        }
        Relationships: []
      }
      platform_branding: {
        Row: {
          created_at: string | null
          favicon_url: string | null
          id: string
          logo_url: string | null
          primary_color: string | null
          pwa_icon_url: string | null
          secondary_color: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          favicon_url?: string | null
          id?: string
          logo_url?: string | null
          primary_color?: string | null
          pwa_icon_url?: string | null
          secondary_color?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          favicon_url?: string | null
          id?: string
          logo_url?: string | null
          primary_color?: string | null
          pwa_icon_url?: string | null
          secondary_color?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      platform_branding_localized: {
        Row: {
          browser_title_format: string | null
          created_at: string | null
          footer_company_text: string | null
          id: string
          knowledge_base_title: string | null
          legal_company_display_name: string | null
          locale: string
          meta_description: string | null
          meta_title: string | null
          platform_name: string
          public_site_title: string | null
          social_share_description: string | null
          social_share_title: string | null
          support_label: string | null
          updated_at: string | null
          widget_display_name: string | null
        }
        Insert: {
          browser_title_format?: string | null
          created_at?: string | null
          footer_company_text?: string | null
          id?: string
          knowledge_base_title?: string | null
          legal_company_display_name?: string | null
          locale: string
          meta_description?: string | null
          meta_title?: string | null
          platform_name?: string
          public_site_title?: string | null
          social_share_description?: string | null
          social_share_title?: string | null
          support_label?: string | null
          updated_at?: string | null
          widget_display_name?: string | null
        }
        Update: {
          browser_title_format?: string | null
          created_at?: string | null
          footer_company_text?: string | null
          id?: string
          knowledge_base_title?: string | null
          legal_company_display_name?: string | null
          locale?: string
          meta_description?: string | null
          meta_title?: string | null
          platform_name?: string
          public_site_title?: string | null
          social_share_description?: string | null
          social_share_title?: string | null
          support_label?: string | null
          updated_at?: string | null
          widget_display_name?: string | null
        }
        Relationships: []
      }
      platform_domains: {
        Row: {
          api_base_url: string | null
          app_base_url: string | null
          asset_base_url: string | null
          canonical_base_url: string | null
          created_at: string | null
          email_base_url: string | null
          help_center_base_url: string | null
          id: string
          primary_domain: string | null
          public_base_url: string | null
          updated_at: string | null
          widget_base_url: string | null
        }
        Insert: {
          api_base_url?: string | null
          app_base_url?: string | null
          asset_base_url?: string | null
          canonical_base_url?: string | null
          created_at?: string | null
          email_base_url?: string | null
          help_center_base_url?: string | null
          id?: string
          primary_domain?: string | null
          public_base_url?: string | null
          updated_at?: string | null
          widget_base_url?: string | null
        }
        Update: {
          api_base_url?: string | null
          app_base_url?: string | null
          asset_base_url?: string | null
          canonical_base_url?: string | null
          created_at?: string | null
          email_base_url?: string | null
          help_center_base_url?: string | null
          id?: string
          primary_domain?: string | null
          public_base_url?: string | null
          updated_at?: string | null
          widget_base_url?: string | null
        }
        Relationships: []
      }
      platform_settings: {
        Row: {
          active_locales: string[]
          created_at: string | null
          default_locale: string
          fallback_locale: string
          id: string
          locale_billing_providers: Json
          maintenance_message: string | null
          maintenance_mode: boolean
          panel_default_locale: string
          site_mode: string
          timezone: string
          updated_at: string | null
          widget_default_locale: string
        }
        Insert: {
          active_locales?: string[]
          created_at?: string | null
          default_locale?: string
          fallback_locale?: string
          id?: string
          locale_billing_providers?: Json
          maintenance_message?: string | null
          maintenance_mode?: boolean
          panel_default_locale?: string
          site_mode?: string
          timezone?: string
          updated_at?: string | null
          widget_default_locale?: string
        }
        Update: {
          active_locales?: string[]
          created_at?: string | null
          default_locale?: string
          fallback_locale?: string
          id?: string
          locale_billing_providers?: Json
          maintenance_message?: string | null
          maintenance_mode?: boolean
          panel_default_locale?: string
          site_mode?: string
          timezone?: string
          updated_at?: string | null
          widget_default_locale?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          ai_mode: string | null
          avatar_url: string | null
          company_name: string | null
          created_at: string | null
          email: string
          full_name: string | null
          id: string
          main_goal: string | null
          preferred_locale: string | null
          signup_ip: string | null
          signup_locale: string | null
          updated_at: string | null
          website_domain: string | null
        }
        Insert: {
          ai_mode?: string | null
          avatar_url?: string | null
          company_name?: string | null
          created_at?: string | null
          email: string
          full_name?: string | null
          id: string
          main_goal?: string | null
          preferred_locale?: string | null
          signup_ip?: string | null
          signup_locale?: string | null
          updated_at?: string | null
          website_domain?: string | null
        }
        Update: {
          ai_mode?: string | null
          avatar_url?: string | null
          company_name?: string | null
          created_at?: string | null
          email?: string
          full_name?: string | null
          id?: string
          main_goal?: string | null
          preferred_locale?: string | null
          signup_ip?: string | null
          signup_locale?: string | null
          updated_at?: string | null
          website_domain?: string | null
        }
        Relationships: []
      }
      provider_configs: {
        Row: {
          config: Json | null
          created_at: string | null
          id: string
          is_active: boolean | null
          provider_name: string
          provider_type: string
          updated_at: string | null
          workspace_id: string
        }
        Insert: {
          config?: Json | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          provider_name: string
          provider_type: string
          updated_at?: string | null
          workspace_id: string
        }
        Update: {
          config?: Json | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          provider_name?: string
          provider_type?: string
          updated_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_configs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      security_events: {
        Row: {
          created_at: string | null
          endpoint: string | null
          event_type: string
          id: string
          ip_address: string | null
          metadata: Json | null
          resolved: boolean | null
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          user_email: string | null
          user_id: string | null
          workspace_id: string | null
        }
        Insert: {
          created_at?: string | null
          endpoint?: string | null
          event_type: string
          id?: string
          ip_address?: string | null
          metadata?: Json | null
          resolved?: boolean | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          user_email?: string | null
          user_id?: string | null
          workspace_id?: string | null
        }
        Update: {
          created_at?: string | null
          endpoint?: string | null
          event_type?: string
          id?: string
          ip_address?: string | null
          metadata?: Json | null
          resolved?: boolean | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          user_email?: string | null
          user_id?: string | null
          workspace_id?: string | null
        }
        Relationships: []
      }
      storage_usage_logs: {
        Row: {
          content_type: string | null
          created_at: string | null
          error_message: string | null
          file_key: string | null
          file_size: number | null
          id: string
          metadata: Json | null
          operation: string
          provider_name: string
          success: boolean
          workspace_id: string
        }
        Insert: {
          content_type?: string | null
          created_at?: string | null
          error_message?: string | null
          file_key?: string | null
          file_size?: number | null
          id?: string
          metadata?: Json | null
          operation: string
          provider_name: string
          success?: boolean
          workspace_id: string
        }
        Update: {
          content_type?: string | null
          created_at?: string | null
          error_message?: string | null
          file_key?: string | null
          file_size?: number | null
          id?: string
          metadata?: Json | null
          operation?: string
          provider_name?: string
          success?: boolean
          workspace_id?: string
        }
        Relationships: []
      }
      translations: {
        Row: {
          id: string
          key: string
          locale: string
          namespace: string
          value: string
          workspace_id: string | null
        }
        Insert: {
          id?: string
          key: string
          locale: string
          namespace: string
          value: string
          workspace_id?: string | null
        }
        Update: {
          id?: string
          key?: string
          locale?: string
          namespace?: string
          value?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "translations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      visitor_presence: {
        Row: {
          current_page: string | null
          id: string
          status: Database["public"]["Enums"]["presence_status"] | null
          updated_at: string | null
          visitor_session_id: string
          workspace_id: string
        }
        Insert: {
          current_page?: string | null
          id?: string
          status?: Database["public"]["Enums"]["presence_status"] | null
          updated_at?: string | null
          visitor_session_id: string
          workspace_id: string
        }
        Update: {
          current_page?: string | null
          id?: string
          status?: Database["public"]["Enums"]["presence_status"] | null
          updated_at?: string | null
          visitor_session_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "visitor_presence_visitor_session_id_fkey"
            columns: ["visitor_session_id"]
            isOneToOne: false
            referencedRelation: "visitor_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visitor_presence_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      visitor_sessions: {
        Row: {
          browser: string | null
          city: string | null
          country: string | null
          current_page: string | null
          device: string | null
          id: string
          ip_hash: string | null
          last_seen_at: string | null
          os: string | null
          referrer: string | null
          started_at: string | null
          visitor_id: string
          workspace_id: string
        }
        Insert: {
          browser?: string | null
          city?: string | null
          country?: string | null
          current_page?: string | null
          device?: string | null
          id?: string
          ip_hash?: string | null
          last_seen_at?: string | null
          os?: string | null
          referrer?: string | null
          started_at?: string | null
          visitor_id: string
          workspace_id: string
        }
        Update: {
          browser?: string | null
          city?: string | null
          country?: string | null
          current_page?: string | null
          device?: string | null
          id?: string
          ip_hash?: string | null
          last_seen_at?: string | null
          os?: string | null
          referrer?: string | null
          started_at?: string | null
          visitor_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "visitor_sessions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      widget_settings: {
        Row: {
          allow_subdomains: boolean
          allowed_domains: string[] | null
          auto_open_delay: number | null
          chat_enabled: boolean | null
          created_at: string | null
          debug_mode: boolean
          default_mode: string | null
          enabled: boolean | null
          fab_animation: boolean | null
          fab_chat_label: string | null
          fab_help_icon: string | null
          fab_help_label: string | null
          fab_icon: string | null
          fab_icon_color: string | null
          fab_label: string | null
          fab_scale: number | null
          fab_shape: string | null
          fab_text_color: string | null
          greeting_message: string | null
          id: string
          kb_enabled: boolean | null
          launcher_text: string | null
          locale: string | null
          logo_url: string | null
          mobile_behavior: string | null
          offline_message: string | null
          placeholder_text: string | null
          position: string | null
          primary_color: string | null
          secondary_color: string | null
          show_logo: boolean | null
          support_mode: string | null
          theme: string | null
          updated_at: string | null
          visitor_tracking_enabled: boolean | null
          welcome_message: string | null
          widget_language: string | null
          workspace_id: string
        }
        Insert: {
          allow_subdomains?: boolean
          allowed_domains?: string[] | null
          auto_open_delay?: number | null
          chat_enabled?: boolean | null
          created_at?: string | null
          debug_mode?: boolean
          default_mode?: string | null
          enabled?: boolean | null
          fab_animation?: boolean | null
          fab_chat_label?: string | null
          fab_help_icon?: string | null
          fab_help_label?: string | null
          fab_icon?: string | null
          fab_icon_color?: string | null
          fab_label?: string | null
          fab_scale?: number | null
          fab_shape?: string | null
          fab_text_color?: string | null
          greeting_message?: string | null
          id?: string
          kb_enabled?: boolean | null
          launcher_text?: string | null
          locale?: string | null
          logo_url?: string | null
          mobile_behavior?: string | null
          offline_message?: string | null
          placeholder_text?: string | null
          position?: string | null
          primary_color?: string | null
          secondary_color?: string | null
          show_logo?: boolean | null
          support_mode?: string | null
          theme?: string | null
          updated_at?: string | null
          visitor_tracking_enabled?: boolean | null
          welcome_message?: string | null
          widget_language?: string | null
          workspace_id: string
        }
        Update: {
          allow_subdomains?: boolean
          allowed_domains?: string[] | null
          auto_open_delay?: number | null
          chat_enabled?: boolean | null
          created_at?: string | null
          debug_mode?: boolean
          default_mode?: string | null
          enabled?: boolean | null
          fab_animation?: boolean | null
          fab_chat_label?: string | null
          fab_help_icon?: string | null
          fab_help_label?: string | null
          fab_icon?: string | null
          fab_icon_color?: string | null
          fab_label?: string | null
          fab_scale?: number | null
          fab_shape?: string | null
          fab_text_color?: string | null
          greeting_message?: string | null
          id?: string
          kb_enabled?: boolean | null
          launcher_text?: string | null
          locale?: string | null
          logo_url?: string | null
          mobile_behavior?: string | null
          offline_message?: string | null
          placeholder_text?: string | null
          position?: string | null
          primary_color?: string | null
          secondary_color?: string | null
          show_logo?: boolean | null
          support_mode?: string | null
          theme?: string | null
          updated_at?: string | null
          visitor_tracking_enabled?: boolean | null
          welcome_message?: string | null
          widget_language?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "widget_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_branding: {
        Row: {
          accent_color: string | null
          asset_base_url: string | null
          canonical_base_url: string | null
          created_at: string | null
          favicon_url: string | null
          footer_text: string | null
          id: string
          legal_name: string | null
          logo_url: string | null
          meta_description: string | null
          meta_title: string | null
          panel_base_url: string | null
          platform_name: string
          primary_color: string | null
          sender_name: string | null
          short_name: string | null
          social_image_url: string | null
          support_email: string | null
          updated_at: string | null
          widget_api_base_url: string | null
          widget_base_url: string | null
          widget_loader_base_url: string | null
          widget_public_base_url: string | null
          workspace_id: string
        }
        Insert: {
          accent_color?: string | null
          asset_base_url?: string | null
          canonical_base_url?: string | null
          created_at?: string | null
          favicon_url?: string | null
          footer_text?: string | null
          id?: string
          legal_name?: string | null
          logo_url?: string | null
          meta_description?: string | null
          meta_title?: string | null
          panel_base_url?: string | null
          platform_name?: string
          primary_color?: string | null
          sender_name?: string | null
          short_name?: string | null
          social_image_url?: string | null
          support_email?: string | null
          updated_at?: string | null
          widget_api_base_url?: string | null
          widget_base_url?: string | null
          widget_loader_base_url?: string | null
          widget_public_base_url?: string | null
          workspace_id: string
        }
        Update: {
          accent_color?: string | null
          asset_base_url?: string | null
          canonical_base_url?: string | null
          created_at?: string | null
          favicon_url?: string | null
          footer_text?: string | null
          id?: string
          legal_name?: string | null
          logo_url?: string | null
          meta_description?: string | null
          meta_title?: string | null
          panel_base_url?: string | null
          platform_name?: string
          primary_color?: string | null
          sender_name?: string | null
          short_name?: string | null
          social_image_url?: string | null
          support_email?: string | null
          updated_at?: string | null
          widget_api_base_url?: string | null
          widget_base_url?: string | null
          widget_loader_base_url?: string | null
          widget_public_base_url?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_branding_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_branding_localized: {
        Row: {
          browser_title_format: string | null
          created_at: string | null
          footer_company_text: string | null
          id: string
          knowledge_base_title: string | null
          legal_company_display_name: string | null
          locale: string
          meta_description: string | null
          meta_title: string | null
          platform_name: string | null
          public_site_title: string | null
          social_share_description: string | null
          social_share_title: string | null
          support_label: string | null
          updated_at: string | null
          widget_display_name: string | null
          workspace_id: string
        }
        Insert: {
          browser_title_format?: string | null
          created_at?: string | null
          footer_company_text?: string | null
          id?: string
          knowledge_base_title?: string | null
          legal_company_display_name?: string | null
          locale: string
          meta_description?: string | null
          meta_title?: string | null
          platform_name?: string | null
          public_site_title?: string | null
          social_share_description?: string | null
          social_share_title?: string | null
          support_label?: string | null
          updated_at?: string | null
          widget_display_name?: string | null
          workspace_id: string
        }
        Update: {
          browser_title_format?: string | null
          created_at?: string | null
          footer_company_text?: string | null
          id?: string
          knowledge_base_title?: string | null
          legal_company_display_name?: string | null
          locale?: string
          meta_description?: string | null
          meta_title?: string | null
          platform_name?: string | null
          public_site_title?: string | null
          social_share_description?: string | null
          social_share_title?: string | null
          support_label?: string | null
          updated_at?: string | null
          widget_display_name?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_branding_localized_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_domains: {
        Row: {
          created_at: string | null
          domain: string
          id: string
          is_primary: boolean | null
          verified: boolean | null
          workspace_id: string
        }
        Insert: {
          created_at?: string | null
          domain: string
          id?: string
          is_primary?: boolean | null
          verified?: boolean | null
          workspace_id: string
        }
        Update: {
          created_at?: string | null
          domain?: string
          id?: string
          is_primary?: boolean | null
          verified?: boolean | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_domains_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_domains_extended: {
        Row: {
          api_base_url: string | null
          app_base_url: string | null
          asset_base_url: string | null
          canonical_base_url: string | null
          created_at: string | null
          email_base_url: string | null
          help_center_base_url: string | null
          id: string
          primary_domain: string | null
          public_base_url: string | null
          updated_at: string | null
          widget_base_url: string | null
          workspace_id: string
        }
        Insert: {
          api_base_url?: string | null
          app_base_url?: string | null
          asset_base_url?: string | null
          canonical_base_url?: string | null
          created_at?: string | null
          email_base_url?: string | null
          help_center_base_url?: string | null
          id?: string
          primary_domain?: string | null
          public_base_url?: string | null
          updated_at?: string | null
          widget_base_url?: string | null
          workspace_id: string
        }
        Update: {
          api_base_url?: string | null
          app_base_url?: string | null
          asset_base_url?: string | null
          canonical_base_url?: string | null
          created_at?: string | null
          email_base_url?: string | null
          help_center_base_url?: string | null
          id?: string
          primary_domain?: string | null
          public_base_url?: string | null
          updated_at?: string | null
          widget_base_url?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_domains_extended_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_invitations: {
        Row: {
          created_at: string
          created_by: string
          expires_at: string | null
          id: string
          invited_email: string | null
          max_uses: number
          revoked_at: string | null
          role: Database["public"]["Enums"]["workspace_role"]
          token: string
          use_count: number
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          expires_at?: string | null
          id?: string
          invited_email?: string | null
          max_uses?: number
          revoked_at?: string | null
          role?: Database["public"]["Enums"]["workspace_role"]
          token?: string
          use_count?: number
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          expires_at?: string | null
          id?: string
          invited_email?: string | null
          max_uses?: number
          revoked_at?: string | null
          role?: Database["public"]["Enums"]["workspace_role"]
          token?: string
          use_count?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invitations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          created_at: string | null
          id: string
          role: Database["public"]["Enums"]["workspace_role"]
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_provider_settings: {
        Row: {
          config: Json
          created_at: string
          enabled: boolean
          id: string
          provider_name: string
          provider_type: string
          secrets: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          config?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          provider_name?: string
          provider_type: string
          secrets?: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          config?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          provider_name?: string
          provider_type?: string
          secrets?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_provider_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_settings: {
        Row: {
          active_locales: string[] | null
          created_at: string | null
          default_locale: string | null
          fallback_locale: string | null
          id: string
          panel_default_locale: string | null
          site_mode: string | null
          updated_at: string | null
          widget_default_locale: string | null
          workspace_id: string
        }
        Insert: {
          active_locales?: string[] | null
          created_at?: string | null
          default_locale?: string | null
          fallback_locale?: string | null
          id?: string
          panel_default_locale?: string | null
          site_mode?: string | null
          updated_at?: string | null
          widget_default_locale?: string | null
          workspace_id: string
        }
        Update: {
          active_locales?: string[] | null
          created_at?: string | null
          default_locale?: string | null
          fallback_locale?: string | null
          id?: string
          panel_default_locale?: string | null
          site_mode?: string | null
          updated_at?: string | null
          widget_default_locale?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_subscriptions: {
        Row: {
          cancel_at_period_end: boolean | null
          created_at: string | null
          current_period_end: string | null
          current_period_start: string | null
          id: string
          metadata: Json | null
          plan_id: string | null
          provider_customer_id: string | null
          provider_name: string
          provider_subscription_id: string | null
          status: string
          trial_end: string | null
          updated_at: string | null
          workspace_id: string
        }
        Insert: {
          cancel_at_period_end?: boolean | null
          created_at?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          metadata?: Json | null
          plan_id?: string | null
          provider_customer_id?: string | null
          provider_name?: string
          provider_subscription_id?: string | null
          status?: string
          trial_end?: string | null
          updated_at?: string | null
          workspace_id: string
        }
        Update: {
          cancel_at_period_end?: boolean | null
          created_at?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          metadata?: Json | null
          plan_id?: string | null
          provider_customer_id?: string | null
          provider_name?: string
          provider_subscription_id?: string | null
          status?: string
          trial_end?: string | null
          updated_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_subscriptions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          account_id: string | null
          created_at: string | null
          default_locale: string | null
          id: string
          name: string
          owner_id: string
          panel_locale: string | null
          slug: string
          updated_at: string | null
          widget_locale: string | null
        }
        Insert: {
          account_id?: string | null
          created_at?: string | null
          default_locale?: string | null
          id?: string
          name: string
          owner_id: string
          panel_locale?: string | null
          slug: string
          updated_at?: string | null
          widget_locale?: string | null
        }
        Update: {
          account_id?: string | null
          created_at?: string | null
          default_locale?: string | null
          id?: string
          name?: string
          owner_id?: string
          panel_locale?: string | null
          slug?: string
          updated_at?: string | null
          widget_locale?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      billing_plans_public: {
        Row: {
          default_currency: string | null
          description: string | null
          entitlements: Json | null
          id: string | null
          is_free: boolean | null
          limits: Json | null
          name: string | null
          prices: Json | null
          slug: string | null
          sort_order: number | null
          trial_days: number | null
        }
        Insert: {
          default_currency?: string | null
          description?: string | null
          entitlements?: Json | null
          id?: string | null
          is_free?: boolean | null
          limits?: Json | null
          name?: string | null
          prices?: Json | null
          slug?: string | null
          sort_order?: number | null
          trial_days?: number | null
        }
        Update: {
          default_currency?: string | null
          description?: string | null
          entitlements?: Json | null
          id?: string | null
          is_free?: boolean | null
          limits?: Json | null
          name?: string | null
          prices?: Json | null
          slug?: string | null
          sort_order?: number | null
          trial_days?: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      accept_workspace_invitation: { Args: { _token: string }; Returns: Json }
      admin_count_profiles: { Args: never; Returns: number }
      admin_count_workspaces: { Args: never; Returns: number }
      admin_delete_workspace: {
        Args: { _workspace_id: string }
        Returns: boolean
      }
      admin_get_user_detail: { Args: { _user_id: string }; Returns: Json }
      admin_get_workspace_detail: {
        Args: { _workspace_id: string }
        Returns: Json
      }
      admin_list_login_attempts: {
        Args: { _email: string; _limit?: number }
        Returns: Json
      }
      admin_list_profiles: {
        Args: {
          _limit?: number
          _offset?: number
          _search?: string
          _sort?: string
        }
        Returns: Json
      }
      admin_list_workspaces:
        | {
            Args: { _limit?: number; _offset?: number }
            Returns: {
              created_at: string
              id: string
              member_count: number
              name: string
              owner_email: string
              owner_id: string
              slug: string
              updated_at: string
            }[]
          }
        | {
            Args: {
              _limit?: number
              _offset?: number
              _search?: string
              _sort?: string
            }
            Returns: Json
          }
      admin_security_stats: { Args: never; Returns: Json }
      bootstrap_admin: { Args: { _user_id: string }; Returns: boolean }
      check_workspace_entitlement: {
        Args: { _feature: string; _workspace_id: string }
        Returns: Json
      }
      cleanup_expired_auth_tokens: { Args: never; Returns: undefined }
      count_recent_login_failures: {
        Args: { _email: string; _ip: string; _window_minutes?: number }
        Returns: number
      }
      create_workspace_atomic: {
        Args: {
          _account_id: string
          _name: string
          _slug: string
          _user_id: string
        }
        Returns: string
      }
      generate_short_id: { Args: { prefix?: string }; Returns: string }
      get_account_role: {
        Args: { _account_id: string; _user_id: string }
        Returns: string
      }
      get_invitation_info: { Args: { _token: string }; Returns: Json }
      get_workspace_role: {
        Args: { _user_id: string; _workspace_id: string }
        Returns: Database["public"]["Enums"]["workspace_role"]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_account_member: {
        Args: { _account_id: string; _user_id: string }
        Returns: boolean
      }
      is_ip_blocked: { Args: { _ip: string }; Returns: boolean }
      is_workspace_member: {
        Args: { _user_id: string; _workspace_id: string }
        Returns: boolean
      }
      provision_account_on_signup: {
        Args: { _user_id: string }
        Returns: undefined
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
      article_status: "draft" | "published" | "archived"
      conversation_priority: "low" | "normal" | "high" | "urgent"
      conversation_status: "open" | "pending" | "resolved" | "closed"
      presence_status: "online" | "idle" | "offline"
      sender_type: "agent" | "contact" | "system" | "bot"
      workspace_role:
        | "owner"
        | "admin"
        | "agent"
        | "viewer"
        | "team_lead"
        | "sales_agent"
        | "support_agent"
        | "marketing_manager"
        | "seo_manager"
        | "analyst"
        | "developer"
        | "billing"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
      article_status: ["draft", "published", "archived"],
      conversation_priority: ["low", "normal", "high", "urgent"],
      conversation_status: ["open", "pending", "resolved", "closed"],
      presence_status: ["online", "idle", "offline"],
      sender_type: ["agent", "contact", "system", "bot"],
      workspace_role: [
        "owner",
        "admin",
        "agent",
        "viewer",
        "team_lead",
        "sales_agent",
        "support_agent",
        "marketing_manager",
        "seo_manager",
        "analyst",
        "developer",
        "billing",
      ],
    },
  },
} as const
