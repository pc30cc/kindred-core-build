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
      alert_events: {
        Row: {
          details: Json
          fired_at: string
          id: string
          metric_value: number | null
          resolved_at: string | null
          rule_id: string
          rule_slug: string
          sample_size: number | null
          severity: string
          state: string
          threshold_value: number | null
          webhook_attempts: number
          webhook_last_attempt_at: string | null
          webhook_last_error: string | null
          webhook_status: string | null
          window_seconds: number
        }
        Insert: {
          details?: Json
          fired_at?: string
          id?: string
          metric_value?: number | null
          resolved_at?: string | null
          rule_id: string
          rule_slug: string
          sample_size?: number | null
          severity: string
          state: string
          threshold_value?: number | null
          webhook_attempts?: number
          webhook_last_attempt_at?: string | null
          webhook_last_error?: string | null
          webhook_status?: string | null
          window_seconds: number
        }
        Update: {
          details?: Json
          fired_at?: string
          id?: string
          metric_value?: number | null
          resolved_at?: string | null
          rule_id?: string
          rule_slug?: string
          sample_size?: number | null
          severity?: string
          state?: string
          threshold_value?: number | null
          webhook_attempts?: number
          webhook_last_attempt_at?: string | null
          webhook_last_error?: string | null
          webhook_status?: string | null
          window_seconds?: number
        }
        Relationships: [
          {
            foreignKeyName: "alert_events_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "alert_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      alert_rules: {
        Row: {
          aggregation: string | null
          created_at: string
          critical_threshold: number
          denominator: string | null
          description: string | null
          enabled: boolean
          id: string
          is_builtin: boolean
          kind: string
          metric: string | null
          min_sample: number
          numerator: string | null
          route_group: string | null
          slug: string
          subrules: Json
          title: string
          updated_at: string
          warn_threshold: number
          window_seconds: number
        }
        Insert: {
          aggregation?: string | null
          created_at?: string
          critical_threshold: number
          denominator?: string | null
          description?: string | null
          enabled?: boolean
          id?: string
          is_builtin?: boolean
          kind: string
          metric?: string | null
          min_sample?: number
          numerator?: string | null
          route_group?: string | null
          slug: string
          subrules?: Json
          title: string
          updated_at?: string
          warn_threshold: number
          window_seconds?: number
        }
        Update: {
          aggregation?: string | null
          created_at?: string
          critical_threshold?: number
          denominator?: string | null
          description?: string | null
          enabled?: boolean
          id?: string
          is_builtin?: boolean
          kind?: string
          metric?: string | null
          min_sample?: number
          numerator?: string | null
          route_group?: string | null
          slug?: string
          subrules?: Json
          title?: string
          updated_at?: string
          warn_threshold?: number
          window_seconds?: number
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
      auto_action_definitions: {
        Row: {
          action_type: string
          cooldown_seconds: number
          created_at: string
          description: string | null
          enabled: boolean
          id: string
          is_builtin: boolean
          max_duration_seconds: number
          min_severity: string
          slug: string
          title: string
          trigger_rule_slug: string | null
          updated_at: string
        }
        Insert: {
          action_type: string
          cooldown_seconds?: number
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          is_builtin?: boolean
          max_duration_seconds?: number
          min_severity?: string
          slug: string
          title: string
          trigger_rule_slug?: string | null
          updated_at?: string
        }
        Update: {
          action_type?: string
          cooldown_seconds?: number
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          is_builtin?: boolean
          max_duration_seconds?: number
          min_severity?: string
          slug?: string
          title?: string
          trigger_rule_slug?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      auto_action_events: {
        Row: {
          action_slug: string
          action_type: string
          definition_id: string
          details: Json
          ended_at: string | null
          ended_reason: string | null
          expires_at: string
          id: string
          started_at: string
          state: string
          trigger_alert_event_id: string | null
          trigger_rule_slug: string | null
          trigger_severity: string | null
        }
        Insert: {
          action_slug: string
          action_type: string
          definition_id: string
          details?: Json
          ended_at?: string | null
          ended_reason?: string | null
          expires_at: string
          id?: string
          started_at?: string
          state: string
          trigger_alert_event_id?: string | null
          trigger_rule_slug?: string | null
          trigger_severity?: string | null
        }
        Update: {
          action_slug?: string
          action_type?: string
          definition_id?: string
          details?: Json
          ended_at?: string | null
          ended_reason?: string | null
          expires_at?: string
          id?: string
          started_at?: string
          state?: string
          trigger_alert_event_id?: string | null
          trigger_rule_slug?: string | null
          trigger_severity?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "auto_action_events_definition_id_fkey"
            columns: ["definition_id"]
            isOneToOne: false
            referencedRelation: "auto_action_definitions"
            referencedColumns: ["id"]
          },
        ]
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
      canned_responses: {
        Row: {
          body: string
          created_at: string
          created_by: string
          id: string
          is_active: boolean
          last_used_at: string | null
          locale: string
          shortcut: string
          title: string
          updated_at: string
          usage_count: number
          workspace_id: string
        }
        Insert: {
          body: string
          created_at?: string
          created_by: string
          id?: string
          is_active?: boolean
          last_used_at?: string | null
          locale: string
          shortcut: string
          title: string
          updated_at?: string
          usage_count?: number
          workspace_id: string
        }
        Update: {
          body?: string
          created_at?: string
          created_by?: string
          id?: string
          is_active?: boolean
          last_used_at?: string | null
          locale?: string
          shortcut?: string
          title?: string
          updated_at?: string
          usage_count?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "canned_responses_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_verifications: {
        Row: {
          attempts: number
          channel: string
          created_at: string
          expires_at: string
          id: string
          identifier: string
          ip_address: string | null
          nonce: string
          token_hash: string
          used_at: string | null
          visitor_id: string | null
          workspace_id: string
        }
        Insert: {
          attempts?: number
          channel: string
          created_at?: string
          expires_at: string
          id?: string
          identifier: string
          ip_address?: string | null
          nonce: string
          token_hash: string
          used_at?: string | null
          visitor_id?: string | null
          workspace_id: string
        }
        Update: {
          attempts?: number
          channel?: string
          created_at?: string
          expires_at?: string
          id?: string
          identifier?: string
          ip_address?: string | null
          nonce?: string
          token_hash?: string
          used_at?: string | null
          visitor_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_verifications_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
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
      conversation_attachments: {
        Row: {
          conversation_id: string | null
          created_at: string
          error_message: string | null
          file_name: string
          finalized_at: string | null
          id: string
          message_id: string | null
          mime_type: string
          size_bytes: number
          status: string
          storage_path: string
          storage_provider: string
          uploaded_by_id: string | null
          uploaded_by_type: string
          visitor_session_id: string | null
          workspace_id: string
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string
          error_message?: string | null
          file_name: string
          finalized_at?: string | null
          id?: string
          message_id?: string | null
          mime_type: string
          size_bytes: number
          status?: string
          storage_path: string
          storage_provider: string
          uploaded_by_id?: string | null
          uploaded_by_type: string
          visitor_session_id?: string | null
          workspace_id: string
        }
        Update: {
          conversation_id?: string | null
          created_at?: string
          error_message?: string | null
          file_name?: string
          finalized_at?: string | null
          id?: string
          message_id?: string | null
          mime_type?: string
          size_bytes?: number
          status?: string
          storage_path?: string
          storage_provider?: string
          uploaded_by_id?: string | null
          uploaded_by_type?: string
          visitor_session_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_attachments_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_attachments_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "conversation_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_attachments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_events: {
        Row: {
          actor_id: string | null
          actor_type: string
          conversation_id: string
          created_at: string
          event_type: string
          id: string
          payload: Json
          workspace_id: string
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          conversation_id: string
          created_at?: string
          event_type: string
          id?: string
          payload?: Json
          workspace_id: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          conversation_id?: string
          created_at?: string
          event_type?: string
          id?: string
          payload?: Json
          workspace_id?: string
        }
        Relationships: []
      }
      conversation_messages: {
        Row: {
          body: string
          conversation_id: string
          created_at: string | null
          id: string
          metadata: Json | null
          seen_at: string | null
          sender_id: string | null
          sender_type: Database["public"]["Enums"]["sender_type"]
        }
        Insert: {
          body: string
          conversation_id: string
          created_at?: string | null
          id?: string
          metadata?: Json | null
          seen_at?: string | null
          sender_id?: string | null
          sender_type: Database["public"]["Enums"]["sender_type"]
        }
        Update: {
          body?: string
          conversation_id?: string
          created_at?: string | null
          id?: string
          metadata?: Json | null
          seen_at?: string | null
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
      conversation_notes: {
        Row: {
          author_id: string
          body: string
          conversation_id: string
          created_at: string
          id: string
          metadata: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          author_id: string
          body: string
          conversation_id: string
          created_at?: string
          id?: string
          metadata?: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          author_id?: string
          body?: string
          conversation_id?: string
          created_at?: string
          id?: string
          metadata?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: []
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
      geo_ip_cache: {
        Row: {
          accuracy_level: string | null
          city: string | null
          country_code: string | null
          country_name: string | null
          expires_at: string
          id: string
          ip_hash: string
          is_fallback: boolean
          latitude: number | null
          longitude: number | null
          payload: Json
          region: string | null
          resolved_at: string
          source: string
          timezone: string | null
        }
        Insert: {
          accuracy_level?: string | null
          city?: string | null
          country_code?: string | null
          country_name?: string | null
          expires_at?: string
          id?: string
          ip_hash: string
          is_fallback?: boolean
          latitude?: number | null
          longitude?: number | null
          payload?: Json
          region?: string | null
          resolved_at?: string
          source?: string
          timezone?: string | null
        }
        Update: {
          accuracy_level?: string | null
          city?: string | null
          country_code?: string | null
          country_name?: string | null
          expires_at?: string
          id?: string
          ip_hash?: string
          is_fallback?: boolean
          latitude?: number | null
          longitude?: number | null
          payload?: Json
          region?: string | null
          resolved_at?: string
          source?: string
          timezone?: string | null
        }
        Relationships: []
      }
      identity_merges: {
        Row: {
          contact_id: string
          conversations_merged: number
          id: string
          merged_at: string
          metadata: Json
          method: string
          visitor_id: string
          workspace_id: string
        }
        Insert: {
          contact_id: string
          conversations_merged?: number
          id?: string
          merged_at?: string
          metadata?: Json
          method: string
          visitor_id: string
          workspace_id: string
        }
        Update: {
          contact_id?: string
          conversations_merged?: number
          id?: string
          merged_at?: string
          metadata?: Json
          method?: string
          visitor_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "identity_merges_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "identity_merges_workspace_id_fkey"
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
      perf_process_samples: {
        Row: {
          event_loop_lag_ms: number
          heap_total_bytes: number
          heap_used_bytes: number
          id: string
          occurred_at: string
          rss_bytes: number
          uptime_seconds: number
        }
        Insert: {
          event_loop_lag_ms: number
          heap_total_bytes: number
          heap_used_bytes: number
          id?: string
          occurred_at?: string
          rss_bytes: number
          uptime_seconds: number
        }
        Update: {
          event_loop_lag_ms?: number
          heap_total_bytes?: number
          heap_used_bytes?: number
          id?: string
          occurred_at?: string
          rss_bytes?: number
          uptime_seconds?: number
        }
        Relationships: []
      }
      perf_request_hourly: {
        Row: {
          bucket_hour: string
          count: number
          error_count: number
          histogram: Json
          max_ms: number
          method: string
          route_group: string
          status_group: string
          sum_ms: number
        }
        Insert: {
          bucket_hour: string
          count?: number
          error_count?: number
          histogram?: Json
          max_ms?: number
          method: string
          route_group: string
          status_group: string
          sum_ms?: number
        }
        Update: {
          bucket_hour?: string
          count?: number
          error_count?: number
          histogram?: Json
          max_ms?: number
          method?: string
          route_group?: string
          status_group?: string
          sum_ms?: number
        }
        Relationships: []
      }
      perf_request_samples: {
        Row: {
          duration_ms: number
          id: string
          is_error: boolean
          method: string
          occurred_at: string
          route_group: string
          status_code: number
          status_group: string
        }
        Insert: {
          duration_ms: number
          id?: string
          is_error?: boolean
          method: string
          occurred_at?: string
          route_group: string
          status_code: number
          status_group: string
        }
        Update: {
          duration_ms?: number
          id?: string
          is_error?: boolean
          method?: string
          occurred_at?: string
          route_group?: string
          status_code?: number
          status_group?: string
        }
        Relationships: []
      }
      plan_change_log: {
        Row: {
          change_type: string
          changed_by: string | null
          created_at: string
          id: string
          metadata: Json | null
          new_plan_id: string | null
          old_plan_id: string | null
          workspace_id: string
        }
        Insert: {
          change_type?: string
          changed_by?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          new_plan_id?: string | null
          old_plan_id?: string | null
          workspace_id: string
        }
        Update: {
          change_type?: string
          changed_by?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          new_plan_id?: string | null
          old_plan_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_change_log_new_plan_id_fkey"
            columns: ["new_plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_change_log_new_plan_id_fkey"
            columns: ["new_plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_change_log_old_plan_id_fkey"
            columns: ["old_plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_change_log_old_plan_id_fkey"
            columns: ["old_plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_change_log_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
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
      privacy_jobs: {
        Row: {
          action: string
          actor_user_id: string
          artifact_hash: string | null
          artifact_path: string | null
          artifact_size_bytes: number | null
          artifact_storage_key: string | null
          artifact_storage_provider: string | null
          cancelled_at: string | null
          completed_at: string | null
          download_count: number
          download_token_hash: string | null
          error_message: string | null
          expires_at: string | null
          id: string
          requested_at: string
          resolved_identity: Json
          scope: Json
          started_at: string | null
          status: string
          subject_email_hash: string | null
          subject_id: string
          subject_type: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id: string
          artifact_hash?: string | null
          artifact_path?: string | null
          artifact_size_bytes?: number | null
          artifact_storage_key?: string | null
          artifact_storage_provider?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          download_count?: number
          download_token_hash?: string | null
          error_message?: string | null
          expires_at?: string | null
          id?: string
          requested_at?: string
          resolved_identity?: Json
          scope?: Json
          started_at?: string | null
          status?: string
          subject_email_hash?: string | null
          subject_id: string
          subject_type: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string
          artifact_hash?: string | null
          artifact_path?: string | null
          artifact_size_bytes?: number | null
          artifact_storage_key?: string | null
          artifact_storage_provider?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          download_count?: number
          download_token_hash?: string | null
          error_message?: string | null
          expires_at?: string | null
          id?: string
          requested_at?: string
          resolved_identity?: Json
          scope?: Json
          started_at?: string | null
          status?: string
          subject_email_hash?: string | null
          subject_id?: string
          subject_type?: string
          workspace_id?: string | null
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
      realtime_metric_events: {
        Row: {
          conversation_id: string | null
          driver: string | null
          id: string
          metric: string
          occurred_at: string
          source: string
          tags: Json
          workspace_id: string | null
        }
        Insert: {
          conversation_id?: string | null
          driver?: string | null
          id?: string
          metric: string
          occurred_at?: string
          source?: string
          tags?: Json
          workspace_id?: string | null
        }
        Update: {
          conversation_id?: string | null
          driver?: string | null
          id?: string
          metric?: string
          occurred_at?: string
          source?: string
          tags?: Json
          workspace_id?: string | null
        }
        Relationships: []
      }
      realtime_metric_hourly: {
        Row: {
          bucket_hour: string
          count: number
          driver: string
          metric: string
        }
        Insert: {
          bucket_hour: string
          count?: number
          driver?: string
          metric: string
        }
        Update: {
          bucket_hour?: string
          count?: number
          driver?: string
          metric?: string
        }
        Relationships: []
      }
      realtime_provider_audit: {
        Row: {
          action: string
          changed_by: string | null
          config_diff: Json | null
          created_at: string
          error_message: string | null
          id: string
          ip_address: string | null
          prev_vendor: string | null
          result: string | null
          vendor: string | null
        }
        Insert: {
          action: string
          changed_by?: string | null
          config_diff?: Json | null
          created_at?: string
          error_message?: string | null
          id?: string
          ip_address?: string | null
          prev_vendor?: string | null
          result?: string | null
          vendor?: string | null
        }
        Update: {
          action?: string
          changed_by?: string | null
          config_diff?: Json | null
          created_at?: string
          error_message?: string | null
          id?: string
          ip_address?: string | null
          prev_vendor?: string | null
          result?: string | null
          vendor?: string | null
        }
        Relationships: []
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
      user_availability_prefs: {
        Row: {
          available_when_using_app: boolean
          created_at: string
          force_offline: boolean
          id: string
          schedule_enabled: boolean
          timezone: string
          updated_at: string
          user_id: string
          weekly_schedule: Json
          workspace_id: string | null
        }
        Insert: {
          available_when_using_app?: boolean
          created_at?: string
          force_offline?: boolean
          id?: string
          schedule_enabled?: boolean
          timezone?: string
          updated_at?: string
          user_id: string
          weekly_schedule?: Json
          workspace_id?: string | null
        }
        Update: {
          available_when_using_app?: boolean
          created_at?: string
          force_offline?: boolean
          id?: string
          schedule_enabled?: boolean
          timezone?: string
          updated_at?: string
          user_id?: string
          weekly_schedule?: Json
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_availability_prefs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      user_continuity_tokens: {
        Row: {
          contact_id: string | null
          created_at: string
          device_info: Json
          expires_at: string
          id: string
          last_used_at: string | null
          revoked_at: string | null
          token_hash: string
          user_id: string | null
          workspace_id: string
        }
        Insert: {
          contact_id?: string | null
          created_at?: string
          device_info?: Json
          expires_at: string
          id?: string
          last_used_at?: string | null
          revoked_at?: string | null
          token_hash: string
          user_id?: string | null
          workspace_id: string
        }
        Update: {
          contact_id?: string | null
          created_at?: string
          device_info?: Json
          expires_at?: string
          id?: string
          last_used_at?: string | null
          revoked_at?: string | null
          token_hash?: string
          user_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_continuity_tokens_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_continuity_tokens_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      user_notification_prefs: {
        Row: {
          created_at: string
          disable_all: boolean
          email_paid_invoices: boolean
          email_product_updates: boolean
          email_transcripts: boolean
          email_unread_messages: boolean
          email_user_ratings: boolean
          email_weekly_summary: boolean
          id: string
          play_sound: boolean
          push_visitor_browsing: boolean
          push_when_offline: boolean
          push_when_online: boolean
          quiet_hours_enabled: boolean
          quiet_hours_end: string | null
          quiet_hours_start: string | null
          quiet_hours_timezone: string | null
          updated_at: string
          user_id: string
          workspace_id: string | null
        }
        Insert: {
          created_at?: string
          disable_all?: boolean
          email_paid_invoices?: boolean
          email_product_updates?: boolean
          email_transcripts?: boolean
          email_unread_messages?: boolean
          email_user_ratings?: boolean
          email_weekly_summary?: boolean
          id?: string
          play_sound?: boolean
          push_visitor_browsing?: boolean
          push_when_offline?: boolean
          push_when_online?: boolean
          quiet_hours_enabled?: boolean
          quiet_hours_end?: string | null
          quiet_hours_start?: string | null
          quiet_hours_timezone?: string | null
          updated_at?: string
          user_id: string
          workspace_id?: string | null
        }
        Update: {
          created_at?: string
          disable_all?: boolean
          email_paid_invoices?: boolean
          email_product_updates?: boolean
          email_transcripts?: boolean
          email_unread_messages?: boolean
          email_user_ratings?: boolean
          email_weekly_summary?: boolean
          id?: string
          play_sound?: boolean
          push_visitor_browsing?: boolean
          push_when_offline?: boolean
          push_when_online?: boolean
          quiet_hours_enabled?: boolean
          quiet_hours_end?: string | null
          quiet_hours_start?: string | null
          quiet_hours_timezone?: string | null
          updated_at?: string
          user_id?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_notification_prefs_workspace_id_fkey"
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
      visitor_geo_cache: {
        Row: {
          city: string | null
          country: string | null
          country_code: string | null
          expires_at: string
          id: string
          ip_hash: string
          latitude: number | null
          longitude: number | null
          region: string | null
          resolved_at: string
          source: string
        }
        Insert: {
          city?: string | null
          country?: string | null
          country_code?: string | null
          expires_at?: string
          id?: string
          ip_hash: string
          latitude?: number | null
          longitude?: number | null
          region?: string | null
          resolved_at?: string
          source?: string
        }
        Update: {
          city?: string | null
          country?: string | null
          country_code?: string | null
          expires_at?: string
          id?: string
          ip_hash?: string
          latitude?: number | null
          longitude?: number | null
          region?: string | null
          resolved_at?: string
          source?: string
        }
        Relationships: []
      }
      visitor_page_views: {
        Row: {
          id: number
          title: string | null
          url: string
          viewed_at: string
          visitor_session_id: string
          workspace_id: string
        }
        Insert: {
          id?: number
          title?: string | null
          url: string
          viewed_at?: string
          visitor_session_id: string
          workspace_id: string
        }
        Update: {
          id?: number
          title?: string | null
          url?: string
          viewed_at?: string
          visitor_session_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "visitor_page_views_visitor_session_id_fkey"
            columns: ["visitor_session_id"]
            isOneToOne: false
            referencedRelation: "visitor_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visitor_page_views_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
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
          contact_id: string | null
          country: string | null
          current_page: string | null
          device: string | null
          geo_accuracy_level: string | null
          geo_city: string | null
          geo_country_code: string | null
          geo_country_name: string | null
          geo_is_fallback: boolean | null
          geo_latitude: number | null
          geo_longitude: number | null
          geo_region: string | null
          geo_resolved_at: string | null
          geo_source_provider: string | null
          geo_timezone: string | null
          id: string
          identity_state: string
          ip_hash: string | null
          ip_raw: string | null
          last_seen_at: string | null
          metadata: Json
          os: string | null
          referrer: string | null
          started_at: string | null
          visitor_id: string
          workspace_id: string
        }
        Insert: {
          browser?: string | null
          city?: string | null
          contact_id?: string | null
          country?: string | null
          current_page?: string | null
          device?: string | null
          geo_accuracy_level?: string | null
          geo_city?: string | null
          geo_country_code?: string | null
          geo_country_name?: string | null
          geo_is_fallback?: boolean | null
          geo_latitude?: number | null
          geo_longitude?: number | null
          geo_region?: string | null
          geo_resolved_at?: string | null
          geo_source_provider?: string | null
          geo_timezone?: string | null
          id?: string
          identity_state?: string
          ip_hash?: string | null
          ip_raw?: string | null
          last_seen_at?: string | null
          metadata?: Json
          os?: string | null
          referrer?: string | null
          started_at?: string | null
          visitor_id: string
          workspace_id: string
        }
        Update: {
          browser?: string | null
          city?: string | null
          contact_id?: string | null
          country?: string | null
          current_page?: string | null
          device?: string | null
          geo_accuracy_level?: string | null
          geo_city?: string | null
          geo_country_code?: string | null
          geo_country_name?: string | null
          geo_is_fallback?: boolean | null
          geo_latitude?: number | null
          geo_longitude?: number | null
          geo_region?: string | null
          geo_resolved_at?: string | null
          geo_source_provider?: string | null
          geo_timezone?: string | null
          id?: string
          identity_state?: string
          ip_hash?: string | null
          ip_raw?: string | null
          last_seen_at?: string | null
          metadata?: Json
          os?: string | null
          referrer?: string | null
          started_at?: string | null
          visitor_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "visitor_sessions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visitor_sessions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      widget_platform_settings: {
        Row: {
          admin_notes: string | null
          alert_webhook_secret: string | null
          alert_webhook_url: string | null
          alerting_enabled: boolean
          created_at: string
          default_allow_subdomains: boolean
          default_debug_mode: boolean
          default_welcome_message: string
          embed_footer_comment: string | null
          embed_header_comment: string | null
          enforce_domain_validation: boolean
          force_chat_enabled: string
          force_kb_enabled: string
          force_visitor_tracking: string
          id: string
          max_allowed_domains_per_workspace: number
          max_message_length: number
          observability_log_level: string
          observability_metrics_enabled: boolean
          observability_structured_logs_enabled: boolean
          perf_memory_budget_mb: number
          prechat_email_policy: string
          prechat_name_policy: string
          prechat_phone_policy: string
          rate_limit_messages_per_minute: number
          realtime_idle_disposal_ms: number
          realtime_message_dedupe_enabled: boolean
          realtime_message_dedupe_window: number
          realtime_pending_max: number
          realtime_reconnect_jitter_pct: number
          realtime_stale_resubscribe_guard_enabled: boolean
          realtime_token_ttl_seconds: number
          typing_rate_limit_enabled: boolean
          typing_rate_limit_max_events: number
          typing_rate_limit_window_ms: number
          updated_at: string
          updated_by: string | null
          widget_api_base_url: string | null
          widget_asset_base_url: string | null
          widget_loader_base_url: string | null
          widget_public_base_url: string | null
        }
        Insert: {
          admin_notes?: string | null
          alert_webhook_secret?: string | null
          alert_webhook_url?: string | null
          alerting_enabled?: boolean
          created_at?: string
          default_allow_subdomains?: boolean
          default_debug_mode?: boolean
          default_welcome_message?: string
          embed_footer_comment?: string | null
          embed_header_comment?: string | null
          enforce_domain_validation?: boolean
          force_chat_enabled?: string
          force_kb_enabled?: string
          force_visitor_tracking?: string
          id?: string
          max_allowed_domains_per_workspace?: number
          max_message_length?: number
          observability_log_level?: string
          observability_metrics_enabled?: boolean
          observability_structured_logs_enabled?: boolean
          perf_memory_budget_mb?: number
          prechat_email_policy?: string
          prechat_name_policy?: string
          prechat_phone_policy?: string
          rate_limit_messages_per_minute?: number
          realtime_idle_disposal_ms?: number
          realtime_message_dedupe_enabled?: boolean
          realtime_message_dedupe_window?: number
          realtime_pending_max?: number
          realtime_reconnect_jitter_pct?: number
          realtime_stale_resubscribe_guard_enabled?: boolean
          realtime_token_ttl_seconds?: number
          typing_rate_limit_enabled?: boolean
          typing_rate_limit_max_events?: number
          typing_rate_limit_window_ms?: number
          updated_at?: string
          updated_by?: string | null
          widget_api_base_url?: string | null
          widget_asset_base_url?: string | null
          widget_loader_base_url?: string | null
          widget_public_base_url?: string | null
        }
        Update: {
          admin_notes?: string | null
          alert_webhook_secret?: string | null
          alert_webhook_url?: string | null
          alerting_enabled?: boolean
          created_at?: string
          default_allow_subdomains?: boolean
          default_debug_mode?: boolean
          default_welcome_message?: string
          embed_footer_comment?: string | null
          embed_header_comment?: string | null
          enforce_domain_validation?: boolean
          force_chat_enabled?: string
          force_kb_enabled?: string
          force_visitor_tracking?: string
          id?: string
          max_allowed_domains_per_workspace?: number
          max_message_length?: number
          observability_log_level?: string
          observability_metrics_enabled?: boolean
          observability_structured_logs_enabled?: boolean
          perf_memory_budget_mb?: number
          prechat_email_policy?: string
          prechat_name_policy?: string
          prechat_phone_policy?: string
          rate_limit_messages_per_minute?: number
          realtime_idle_disposal_ms?: number
          realtime_message_dedupe_enabled?: boolean
          realtime_message_dedupe_window?: number
          realtime_pending_max?: number
          realtime_reconnect_jitter_pct?: number
          realtime_stale_resubscribe_guard_enabled?: boolean
          realtime_token_ttl_seconds?: number
          typing_rate_limit_enabled?: boolean
          typing_rate_limit_max_events?: number
          typing_rate_limit_window_ms?: number
          updated_at?: string
          updated_by?: string | null
          widget_api_base_url?: string | null
          widget_asset_base_url?: string | null
          widget_loader_base_url?: string | null
          widget_public_base_url?: string | null
        }
        Relationships: []
      }
      widget_prechat_settings: {
        Row: {
          ask_email: boolean
          ask_name: boolean
          ask_phone: boolean
          created_at: string
          history_continue_window_hours: number
          require_email: boolean
          require_name: boolean
          require_phone: boolean
          updated_at: string
          verify_email: boolean
          verify_phone: boolean
          workspace_id: string
        }
        Insert: {
          ask_email?: boolean
          ask_name?: boolean
          ask_phone?: boolean
          created_at?: string
          history_continue_window_hours?: number
          require_email?: boolean
          require_name?: boolean
          require_phone?: boolean
          updated_at?: string
          verify_email?: boolean
          verify_phone?: boolean
          workspace_id: string
        }
        Update: {
          ask_email?: boolean
          ask_name?: boolean
          ask_phone?: boolean
          created_at?: string
          history_continue_window_hours?: number
          require_email?: boolean
          require_name?: boolean
          require_phone?: boolean
          updated_at?: string
          verify_email?: boolean
          verify_phone?: boolean
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "widget_prechat_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      widget_settings: {
        Row: {
          allow_subdomains: boolean
          allowed_domains: string[] | null
          attachments_allowed_mimes: string[]
          attachments_enabled: boolean
          attachments_max_size_mb: number
          auto_open_delay: number | null
          availability_labels: Json
          business_hours: Json
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
          live_chat_enabled: boolean
          locale: string | null
          logo_url: string | null
          mobile_behavior: string | null
          offline_message: string | null
          offline_message_localized: Json
          offline_mode: string
          placeholder_text: string | null
          position: string | null
          primary_color: string | null
          read_receipts_enabled: boolean
          secondary_color: string | null
          show_logo: boolean | null
          store_raw_ip: boolean
          support_mode: string | null
          template_slug: string
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
          attachments_allowed_mimes?: string[]
          attachments_enabled?: boolean
          attachments_max_size_mb?: number
          auto_open_delay?: number | null
          availability_labels?: Json
          business_hours?: Json
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
          live_chat_enabled?: boolean
          locale?: string | null
          logo_url?: string | null
          mobile_behavior?: string | null
          offline_message?: string | null
          offline_message_localized?: Json
          offline_mode?: string
          placeholder_text?: string | null
          position?: string | null
          primary_color?: string | null
          read_receipts_enabled?: boolean
          secondary_color?: string | null
          show_logo?: boolean | null
          store_raw_ip?: boolean
          support_mode?: string | null
          template_slug?: string
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
          attachments_allowed_mimes?: string[]
          attachments_enabled?: boolean
          attachments_max_size_mb?: number
          auto_open_delay?: number | null
          availability_labels?: Json
          business_hours?: Json
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
          live_chat_enabled?: boolean
          locale?: string | null
          logo_url?: string | null
          mobile_behavior?: string | null
          offline_message?: string | null
          offline_message_localized?: Json
          offline_mode?: string
          placeholder_text?: string | null
          position?: string | null
          primary_color?: string | null
          read_receipts_enabled?: boolean
          secondary_color?: string | null
          show_logo?: boolean | null
          store_raw_ip?: boolean
          support_mode?: string | null
          template_slug?: string
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
      widget_templates: {
        Row: {
          created_at: string
          description: string | null
          enabled: boolean
          id: string
          is_builtin: boolean
          metadata: Json
          name: string
          slug: string
          sort_order: number
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          is_builtin?: boolean
          metadata?: Json
          name: string
          slug: string
          sort_order?: number
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          is_builtin?: boolean
          metadata?: Json
          name?: string
          slug?: string
          sort_order?: number
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      workspace_branding: {
        Row: {
          accent_color: string | null
          asset_base_url: string | null
          canonical_base_url: string | null
          contact_info: Json
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
          contact_info?: Json
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
          contact_info?: Json
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
      workspace_channel_overrides: {
        Row: {
          admin_notes: string | null
          channel_key: string
          created_at: string
          enabled: boolean
          id: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          admin_notes?: string | null
          channel_key: string
          created_at?: string
          enabled?: boolean
          id?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          admin_notes?: string | null
          channel_key?: string
          created_at?: string
          enabled?: boolean
          id?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_channel_overrides_workspace_id_fkey"
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
      workspace_module_overrides: {
        Row: {
          admin_notes: string | null
          created_at: string
          enabled: boolean
          id: string
          module_key: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          admin_notes?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          module_key: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          admin_notes?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          module_key?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_module_overrides_workspace_id_fkey"
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
      workspace_usage_counters: {
        Row: {
          ai_credits_balance: number
          ai_credits_used: number
          ai_requests_count: number
          conversations_count: number
          created_at: string
          email_sent_count: number
          id: string
          messages_count: number
          period: string
          storage_bytes: number
          updated_at: string
          visitors_count: number
          workspace_id: string
        }
        Insert: {
          ai_credits_balance?: number
          ai_credits_used?: number
          ai_requests_count?: number
          conversations_count?: number
          created_at?: string
          email_sent_count?: number
          id?: string
          messages_count?: number
          period?: string
          storage_bytes?: number
          updated_at?: string
          visitors_count?: number
          workspace_id: string
        }
        Update: {
          ai_credits_balance?: number
          ai_credits_used?: number
          ai_requests_count?: number
          conversations_count?: number
          created_at?: string
          email_sent_count?: number
          id?: string
          messages_count?: number
          period?: string
          storage_bytes?: number
          updated_at?: string
          visitors_count?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_usage_counters_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
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
      activate_auto_actions: { Args: never; Returns: Json }
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
      admin_list_realtime_audit: { Args: { _limit?: number }; Returns: Json }
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
      check_channel_access: {
        Args: { _channel_key: string; _workspace_id: string }
        Returns: Json
      }
      check_module_access: {
        Args: { _module_key: string; _workspace_id: string }
        Returns: Json
      }
      check_workspace_entitlement: {
        Args: { _feature: string; _workspace_id: string }
        Returns: Json
      }
      cleanup_expired_auth_tokens: { Args: never; Returns: undefined }
      cleanup_expired_widget_identity: { Args: never; Returns: undefined }
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
      deduct_ai_credits: {
        Args: { _credits?: number; _period?: string; _workspace_id: string }
        Returns: Json
      }
      evaluate_alert_rules: { Args: never; Returns: Json }
      generate_short_id: { Args: { prefix?: string }; Returns: string }
      get_account_role: {
        Args: { _account_id: string; _user_id: string }
        Returns: string
      }
      get_invitation_info: { Args: { _token: string }; Returns: Json }
      get_widget_platform_settings: { Args: never; Returns: Json }
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
      increment_usage_counter: {
        Args: { _amount?: number; _counter_name: string; _workspace_id: string }
        Returns: undefined
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
      kb_search_articles: {
        Args: {
          p_limit?: number
          p_locale: string
          p_query: string
          p_workspace_id: string
        }
        Returns: {
          category_id: string
          category_name: string
          category_slug: string
          excerpt: string
          id: string
          score: number
          slug: string
          title: string
        }[]
      }
      mark_conversation_seen: {
        Args: { _conversation_id: string }
        Returns: number
      }
      merge_visitor_into_contact: {
        Args: {
          _contact_id: string
          _metadata?: Json
          _method: string
          _visitor_id: string
          _workspace_id: string
        }
        Returns: Json
      }
      normalize_domain: { Args: { _input: string }; Returns: string }
      perf_metrics_rollup_and_prune: { Args: never; Returns: Json }
      provision_account_on_signup: {
        Args: { _user_id: string }
        Returns: undefined
      }
      realtime_metrics_rollup_and_prune: { Args: never; Returns: Json }
      register_workspace_domain: {
        Args: {
          _make_primary?: boolean
          _raw_domain: string
          _workspace_id: string
        }
        Returns: undefined
      }
      resolve_privacy_subject: {
        Args: {
          _subject_id: string
          _subject_type: string
          _workspace_id: string
        }
        Returns: Json
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
      article_status: "draft" | "published" | "archived"
      conversation_priority: "low" | "normal" | "high" | "urgent"
      conversation_status: "open" | "pending" | "resolved" | "closed"
      presence_status: "online" | "idle" | "offline"
      sender_type: "agent" | "contact" | "system" | "bot" | "ai"
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
      sender_type: ["agent", "contact", "system", "bot", "ai"],
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
