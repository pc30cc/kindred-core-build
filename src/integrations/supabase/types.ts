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
      admin_gate_bypass_log: {
        Row: {
          created_at: string
          id: string
          module_key: string
          reason: string | null
          route: string
          user_id: string
          workspace_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          module_key: string
          reason?: string | null
          route: string
          user_id: string
          workspace_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          module_key?: string
          reason?: string | null
          route?: string
          user_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      admin_impersonation_tokens: {
        Row: {
          created_at: string
          created_by: string
          expires_at: string
          id: string
          target_user_id: string
          token_hash: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          created_by: string
          expires_at: string
          id?: string
          target_user_id: string
          token_hash: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string
          expires_at?: string
          id?: string
          target_user_id?: string
          token_hash?: string
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "admin_impersonation_tokens_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_impersonation_tokens_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_action_claims: {
        Row: {
          action_name: string
          conversation_id: string
          created_at: string
          idempotency_key: string
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          action_name: string
          conversation_id: string
          created_at?: string
          idempotency_key: string
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          action_name?: string
          conversation_id?: string
          created_at?: string
          idempotency_key?: string
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: []
      }
      ai_agent_debug_events: {
        Row: {
          actor_user_id: string | null
          created_at: string
          event_type: string
          id: string
          metadata: Json
          run_id: string | null
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          run_id?: string | null
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          run_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_debug_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "ai_agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_debug_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_guidance: {
        Row: {
          body: string
          consumed_at: string | null
          consumed_by_run_id: string | null
          conversation_id: string
          created_at: string
          expires_at: string | null
          id: string
          kind: string
          metadata: Json
          operator_id: string | null
          operator_name: string | null
          request_id: string | null
          scope: string
          status: string
          updated_at: string
          use_count: number
          workspace_id: string
        }
        Insert: {
          body: string
          consumed_at?: string | null
          consumed_by_run_id?: string | null
          conversation_id: string
          created_at?: string
          expires_at?: string | null
          id?: string
          kind?: string
          metadata?: Json
          operator_id?: string | null
          operator_name?: string | null
          request_id?: string | null
          scope?: string
          status?: string
          updated_at?: string
          use_count?: number
          workspace_id: string
        }
        Update: {
          body?: string
          consumed_at?: string | null
          consumed_by_run_id?: string | null
          conversation_id?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          kind?: string
          metadata?: Json
          operator_id?: string | null
          operator_name?: string | null
          request_id?: string | null
          scope?: string
          status?: string
          updated_at?: string
          use_count?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_guidance_conversation_ws_fkey"
            columns: ["conversation_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "ai_agent_guidance_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_guidance_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_guidance_requests: {
        Row: {
          conversation_id: string
          created_at: string
          id: string
          known_summary: string | null
          metadata: Json
          missing_information: string | null
          question: string
          resolved_at: string | null
          resolved_by: string | null
          resolved_guidance_id: string | null
          run_id: string | null
          status: string
          updated_at: string
          visitor_message_id: string | null
          visitor_question: string | null
          workspace_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          id?: string
          known_summary?: string | null
          metadata?: Json
          missing_information?: string | null
          question: string
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_guidance_id?: string | null
          run_id?: string | null
          status?: string
          updated_at?: string
          visitor_message_id?: string | null
          visitor_question?: string | null
          workspace_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          id?: string
          known_summary?: string | null
          metadata?: Json
          missing_information?: string | null
          question?: string
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_guidance_id?: string | null
          run_id?: string | null
          status?: string
          updated_at?: string
          visitor_message_id?: string | null
          visitor_question?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_guidance_requests_conversation_ws_fkey"
            columns: ["conversation_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "ai_agent_guidance_requests_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_guidance_requests_resolved_guidance_id_fkey"
            columns: ["resolved_guidance_id"]
            isOneToOne: false
            referencedRelation: "ai_agent_guidance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_guidance_requests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_guidance_rules: {
        Row: {
          condition_json: Json
          created_at: string
          description: string | null
          enabled: boolean
          id: string
          instruction: string
          priority: number
          rule_type: string
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          condition_json?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          instruction?: string
          priority?: number
          rule_type: string
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          condition_json?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          instruction?: string
          priority?: number
          rule_type?: string
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_guidance_rules_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_intro_log: {
        Row: {
          conversation_id: string | null
          created_at: string
          id: string
          message_id: string | null
          visitor_id: string | null
          visitor_session_id: string | null
          workspace_id: string
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string
          id?: string
          message_id?: string | null
          visitor_id?: string | null
          visitor_session_id?: string | null
          workspace_id: string
        }
        Update: {
          conversation_id?: string | null
          created_at?: string
          id?: string
          message_id?: string | null
          visitor_id?: string | null
          visitor_session_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_intro_log_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_learning_candidates: {
        Row: {
          answer_text: string
          confidence_score: number | null
          conversation_id: string | null
          created_at: string
          id: string
          locale: string | null
          metadata: Json
          normalized_question: string
          operator_message_id: string | null
          question_text: string
          reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          source_type: string
          status: string
          suggested_answer: string | null
          suggested_tags: string[]
          suggested_title: string | null
          updated_at: string
          visitor_message_id: string | null
          workspace_id: string
        }
        Insert: {
          answer_text: string
          confidence_score?: number | null
          conversation_id?: string | null
          created_at?: string
          id?: string
          locale?: string | null
          metadata?: Json
          normalized_question: string
          operator_message_id?: string | null
          question_text: string
          reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_type?: string
          status?: string
          suggested_answer?: string | null
          suggested_tags?: string[]
          suggested_title?: string | null
          updated_at?: string
          visitor_message_id?: string | null
          workspace_id: string
        }
        Update: {
          answer_text?: string
          confidence_score?: number | null
          conversation_id?: string | null
          created_at?: string
          id?: string
          locale?: string | null
          metadata?: Json
          normalized_question?: string
          operator_message_id?: string | null
          question_text?: string
          reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_type?: string
          status?: string
          suggested_answer?: string | null
          suggested_tags?: string[]
          suggested_title?: string | null
          updated_at?: string
          visitor_message_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      ai_agent_message_triggers: {
        Row: {
          action_json: Json
          action_type: string
          conditions_json: Json
          created_at: string
          delay_seconds: number
          description: string | null
          enabled: boolean
          event_type: string
          id: string
          name: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          action_json?: Json
          action_type: string
          conditions_json?: Json
          created_at?: string
          delay_seconds?: number
          description?: string | null
          enabled?: boolean
          event_type: string
          id?: string
          name: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          action_json?: Json
          action_type?: string
          conditions_json?: Json
          created_at?: string
          delay_seconds?: number
          description?: string | null
          enabled?: boolean
          event_type?: string
          id?: string
          name?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_message_triggers_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_qna: {
        Row: {
          answer: string
          created_at: string
          enabled: boolean
          id: string
          locale: string
          question: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          answer: string
          created_at?: string
          enabled?: boolean
          id?: string
          locale?: string
          question: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          answer?: string
          created_at?: string
          enabled?: boolean
          id?: string
          locale?: string
          question?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_qna_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_regression_batches: {
        Row: {
          created_at: string
          created_by: string | null
          errored: number
          failed: number
          finished_at: string | null
          id: string
          last_error: string | null
          metadata: Json
          pass_rate: number | null
          passed: number
          schedule_id: string | null
          started_at: string | null
          status: string
          total_cases: number
          trigger_type: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          errored?: number
          failed?: number
          finished_at?: string | null
          id?: string
          last_error?: string | null
          metadata?: Json
          pass_rate?: number | null
          passed?: number
          schedule_id?: string | null
          started_at?: string | null
          status?: string
          total_cases?: number
          trigger_type?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          errored?: number
          failed?: number
          finished_at?: string | null
          id?: string
          last_error?: string | null
          metadata?: Json
          pass_rate?: number | null
          passed?: number
          schedule_id?: string | null
          started_at?: string | null
          status?: string
          total_cases?: number
          trigger_type?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_regression_batches_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "ai_agent_regression_schedules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_regression_batches_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_regression_schedules: {
        Row: {
          call_llm: boolean
          created_at: string
          created_by: string | null
          enabled: boolean
          frequency: string
          id: string
          include_enabled_cases_only: boolean
          last_run_at: string | null
          max_cases_per_run: number
          metadata: Json
          name: string
          next_run_at: string | null
          time_of_day: string | null
          timezone: string
          updated_at: string
          updated_by: string | null
          workspace_id: string
        }
        Insert: {
          call_llm?: boolean
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          frequency?: string
          id?: string
          include_enabled_cases_only?: boolean
          last_run_at?: string | null
          max_cases_per_run?: number
          metadata?: Json
          name?: string
          next_run_at?: string | null
          time_of_day?: string | null
          timezone?: string
          updated_at?: string
          updated_by?: string | null
          workspace_id: string
        }
        Update: {
          call_llm?: boolean
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          frequency?: string
          id?: string
          include_enabled_cases_only?: boolean
          last_run_at?: string | null
          max_cases_per_run?: number
          metadata?: Json
          name?: string
          next_run_at?: string | null
          time_of_day?: string | null
          timezone?: string
          updated_at?: string
          updated_by?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_regression_schedules_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_routing_rules: {
        Row: {
          action_json: Json
          action_type: string
          conditions_json: Json
          created_at: string
          description: string | null
          enabled: boolean
          id: string
          name: string
          priority: number
          trigger_type: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          action_json?: Json
          action_type: string
          conditions_json?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          name: string
          priority?: number
          trigger_type: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          action_json?: Json
          action_type?: string
          conditions_json?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          name?: string
          priority?: number
          trigger_type?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_routing_rules_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_runs: {
        Row: {
          completion_tokens: number | null
          confidence: number | null
          conversation_id: string | null
          created_at: string
          credits_used: number
          error_message: string | null
          id: string
          input_text: string | null
          kb_article_ids: string[]
          metadata: Json
          mode: string | null
          model: string | null
          output_text: string | null
          prompt_tokens: number | null
          provider: string | null
          run_type: string
          skip_reason: string | null
          status: string
          visitor_message_id: string | null
          workspace_id: string
        }
        Insert: {
          completion_tokens?: number | null
          confidence?: number | null
          conversation_id?: string | null
          created_at?: string
          credits_used?: number
          error_message?: string | null
          id?: string
          input_text?: string | null
          kb_article_ids?: string[]
          metadata?: Json
          mode?: string | null
          model?: string | null
          output_text?: string | null
          prompt_tokens?: number | null
          provider?: string | null
          run_type: string
          skip_reason?: string | null
          status: string
          visitor_message_id?: string | null
          workspace_id: string
        }
        Update: {
          completion_tokens?: number | null
          confidence?: number | null
          conversation_id?: string | null
          created_at?: string
          credits_used?: number
          error_message?: string | null
          id?: string
          input_text?: string | null
          kb_article_ids?: string[]
          metadata?: Json
          mode?: string | null
          model?: string | null
          output_text?: string | null
          prompt_tokens?: number | null
          provider?: string | null
          run_type?: string
          skip_reason?: string | null
          status?: string
          visitor_message_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_runs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_settings: {
        Row: {
          agent_logo_url: string | null
          agent_name: string
          ai_intro_enabled: boolean
          allow_answer_with_caveat: boolean
          allow_clarifying_questions: boolean
          allow_suggestions_after_takeover: boolean
          allowed_locales: string[]
          answer_guidance: string
          answer_only_from_kb: boolean
          auto_create_learning_candidates: boolean
          business_description: string | null
          confidence_threshold: number
          created_at: string
          enabled: boolean
          escalation_style: string
          fallback_behavior: string
          fallback_message: string
          handoff_keywords: string[]
          handoff_message_localized: Json
          handoff_on_human_request: boolean
          handoff_on_low_confidence: boolean
          handoff_policy: string | null
          handoff_prechat_message_localized: Json
          handoff_when_no_kb_match: boolean
          id: string
          instructions: Json
          intro_message: string | null
          intro_message_localized: Json
          keep_in_automated_until_handoff: boolean
          learning_enabled: boolean
          max_assist_attempts: number
          max_clarification_attempts: number
          max_replies_per_conversation: number
          max_replies_per_hour: number
          metadata: Json
          mode: string
          pause_auto_reply_after_human_reply: boolean
          require_approval_for_learning: boolean
          show_sources_to_operator: boolean
          show_sources_to_visitor: boolean
          stop_on_handoff: boolean
          updated_at: string
          welcome_message: string | null
          workspace_id: string
        }
        Insert: {
          agent_logo_url?: string | null
          agent_name?: string
          ai_intro_enabled?: boolean
          allow_answer_with_caveat?: boolean
          allow_clarifying_questions?: boolean
          allow_suggestions_after_takeover?: boolean
          allowed_locales?: string[]
          answer_guidance?: string
          answer_only_from_kb?: boolean
          auto_create_learning_candidates?: boolean
          business_description?: string | null
          confidence_threshold?: number
          created_at?: string
          enabled?: boolean
          escalation_style?: string
          fallback_behavior?: string
          fallback_message?: string
          handoff_keywords?: string[]
          handoff_message_localized?: Json
          handoff_on_human_request?: boolean
          handoff_on_low_confidence?: boolean
          handoff_policy?: string | null
          handoff_prechat_message_localized?: Json
          handoff_when_no_kb_match?: boolean
          id?: string
          instructions?: Json
          intro_message?: string | null
          intro_message_localized?: Json
          keep_in_automated_until_handoff?: boolean
          learning_enabled?: boolean
          max_assist_attempts?: number
          max_clarification_attempts?: number
          max_replies_per_conversation?: number
          max_replies_per_hour?: number
          metadata?: Json
          mode?: string
          pause_auto_reply_after_human_reply?: boolean
          require_approval_for_learning?: boolean
          show_sources_to_operator?: boolean
          show_sources_to_visitor?: boolean
          stop_on_handoff?: boolean
          updated_at?: string
          welcome_message?: string | null
          workspace_id: string
        }
        Update: {
          agent_logo_url?: string | null
          agent_name?: string
          ai_intro_enabled?: boolean
          allow_answer_with_caveat?: boolean
          allow_clarifying_questions?: boolean
          allow_suggestions_after_takeover?: boolean
          allowed_locales?: string[]
          answer_guidance?: string
          answer_only_from_kb?: boolean
          auto_create_learning_candidates?: boolean
          business_description?: string | null
          confidence_threshold?: number
          created_at?: string
          enabled?: boolean
          escalation_style?: string
          fallback_behavior?: string
          fallback_message?: string
          handoff_keywords?: string[]
          handoff_message_localized?: Json
          handoff_on_human_request?: boolean
          handoff_on_low_confidence?: boolean
          handoff_policy?: string | null
          handoff_prechat_message_localized?: Json
          handoff_when_no_kb_match?: boolean
          id?: string
          instructions?: Json
          intro_message?: string | null
          intro_message_localized?: Json
          keep_in_automated_until_handoff?: boolean
          learning_enabled?: boolean
          max_assist_attempts?: number
          max_clarification_attempts?: number
          max_replies_per_conversation?: number
          max_replies_per_hour?: number
          metadata?: Json
          mode?: string
          pause_auto_reply_after_human_reply?: boolean
          require_approval_for_learning?: boolean
          show_sources_to_operator?: boolean
          show_sources_to_visitor?: boolean
          stop_on_handoff?: boolean
          updated_at?: string
          welcome_message?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_sources: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          metadata: Json
          source_type: string
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          metadata?: Json
          source_type: string
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          metadata?: Json
          source_type?: string
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_sources_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_suggested_test_cases: {
        Row: {
          created_at: string
          created_by: string | null
          expected_behavior: string
          expected_contains: string[]
          expected_not_contains: string[]
          expected_source_id: string | null
          expected_source_type: string | null
          expected_source_url: string | null
          id: string
          input_message: string
          locale: string | null
          metadata: Json
          min_confidence: number | null
          name: string
          page_context: Json | null
          reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          source_id: string | null
          source_type: string
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expected_behavior: string
          expected_contains?: string[]
          expected_not_contains?: string[]
          expected_source_id?: string | null
          expected_source_type?: string | null
          expected_source_url?: string | null
          id?: string
          input_message: string
          locale?: string | null
          metadata?: Json
          min_confidence?: number | null
          name: string
          page_context?: Json | null
          reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_id?: string | null
          source_type: string
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expected_behavior?: string
          expected_contains?: string[]
          expected_not_contains?: string[]
          expected_source_id?: string | null
          expected_source_type?: string | null
          expected_source_url?: string | null
          id?: string
          input_message?: string
          locale?: string | null
          metadata?: Json
          min_confidence?: number | null
          name?: string
          page_context?: Json | null
          reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_id?: string | null
          source_type?: string
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: []
      }
      ai_agent_suggestions: {
        Row: {
          confidence: number | null
          conversation_id: string
          created_at: string
          created_by_run_id: string | null
          id: string
          source_article_ids: string[]
          status: string
          suggested_reply: string
          updated_at: string
          visitor_message_id: string | null
          workspace_id: string
        }
        Insert: {
          confidence?: number | null
          conversation_id: string
          created_at?: string
          created_by_run_id?: string | null
          id?: string
          source_article_ids?: string[]
          status?: string
          suggested_reply: string
          updated_at?: string
          visitor_message_id?: string | null
          workspace_id: string
        }
        Update: {
          confidence?: number | null
          conversation_id?: string
          created_at?: string
          created_by_run_id?: string | null
          id?: string
          source_article_ids?: string[]
          status?: string
          suggested_reply?: string
          updated_at?: string
          visitor_message_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_suggestions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_test_cases: {
        Row: {
          created_at: string
          created_by: string | null
          enabled: boolean
          expected_behavior: string
          expected_contains: string[]
          expected_not_contains: string[]
          expected_source_id: string | null
          expected_source_type: string | null
          expected_source_url: string | null
          id: string
          input_message: string
          locale: string | null
          metadata: Json
          min_confidence: number | null
          name: string
          page_context: Json | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          expected_behavior: string
          expected_contains?: string[]
          expected_not_contains?: string[]
          expected_source_id?: string | null
          expected_source_type?: string | null
          expected_source_url?: string | null
          id?: string
          input_message: string
          locale?: string | null
          metadata?: Json
          min_confidence?: number | null
          name: string
          page_context?: Json | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          expected_behavior?: string
          expected_contains?: string[]
          expected_not_contains?: string[]
          expected_source_id?: string | null
          expected_source_type?: string | null
          expected_source_url?: string | null
          id?: string
          input_message?: string
          locale?: string | null
          metadata?: Json
          min_confidence?: number | null
          name?: string
          page_context?: Json | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_test_cases_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_test_runs: {
        Row: {
          actual_output: string | null
          actual_status: string | null
          ai_agent_run_id: string | null
          answer_strategy: Json | null
          confidence: number | null
          created_at: string
          created_by: string | null
          failure_reasons: string[]
          id: string
          input_message: string
          metadata: Json
          regression_batch_id: string | null
          retrieval_debug: Json | null
          selected_sources: Json
          status: string
          test_case_id: string | null
          workspace_id: string
        }
        Insert: {
          actual_output?: string | null
          actual_status?: string | null
          ai_agent_run_id?: string | null
          answer_strategy?: Json | null
          confidence?: number | null
          created_at?: string
          created_by?: string | null
          failure_reasons?: string[]
          id?: string
          input_message: string
          metadata?: Json
          regression_batch_id?: string | null
          retrieval_debug?: Json | null
          selected_sources?: Json
          status: string
          test_case_id?: string | null
          workspace_id: string
        }
        Update: {
          actual_output?: string | null
          actual_status?: string | null
          ai_agent_run_id?: string | null
          answer_strategy?: Json | null
          confidence?: number | null
          created_at?: string
          created_by?: string | null
          failure_reasons?: string[]
          id?: string
          input_message?: string
          metadata?: Json
          regression_batch_id?: string | null
          retrieval_debug?: Json | null
          selected_sources?: Json
          status?: string
          test_case_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_test_runs_regression_batch_id_fkey"
            columns: ["regression_batch_id"]
            isOneToOne: false
            referencedRelation: "ai_agent_regression_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_test_runs_test_case_id_fkey"
            columns: ["test_case_id"]
            isOneToOne: false
            referencedRelation: "ai_agent_test_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_test_runs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_tool_servers: {
        Row: {
          allowed_tools: string[]
          auth_type: string
          created_at: string
          encrypted_config: Json | null
          endpoint_url: string | null
          id: string
          last_checked_at: string | null
          last_error: string | null
          name: string
          permissions_json: Json
          server_type: string
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          allowed_tools?: string[]
          auth_type?: string
          created_at?: string
          encrypted_config?: Json | null
          endpoint_url?: string | null
          id?: string
          last_checked_at?: string | null
          last_error?: string | null
          name: string
          permissions_json?: Json
          server_type?: string
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          allowed_tools?: string[]
          auth_type?: string
          created_at?: string
          encrypted_config?: Json | null
          endpoint_url?: string | null
          id?: string
          last_checked_at?: string | null
          last_error?: string | null
          name?: string
          permissions_json?: Json
          server_type?: string
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_tool_servers_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_tools: {
        Row: {
          config_json: Json
          created_at: string
          description: string | null
          enabled: boolean
          id: string
          name: string
          permissions_json: Json
          provider: string | null
          risk_level: string
          server_id: string | null
          tool_type: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          config_json?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          name: string
          permissions_json?: Json
          provider?: string | null
          risk_level?: string
          server_id?: string | null
          tool_type: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          config_json?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          name?: string
          permissions_json?: Json
          provider?: string | null
          risk_level?: string
          server_id?: string | null
          tool_type?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_tools_server_id_fkey"
            columns: ["server_id"]
            isOneToOne: false
            referencedRelation: "ai_agent_tool_servers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_tools_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_topics: {
        Row: {
          action: string
          action_json: Json
          confidence_threshold: number
          created_at: string
          description: string | null
          enabled: boolean
          examples: string[]
          id: string
          keywords: string[]
          language: string | null
          name: string
          slug: string
          system: boolean
          updated_at: string
          workspace_id: string
        }
        Insert: {
          action?: string
          action_json?: Json
          confidence_threshold?: number
          created_at?: string
          description?: string | null
          enabled?: boolean
          examples?: string[]
          id?: string
          keywords?: string[]
          language?: string | null
          name: string
          slug: string
          system?: boolean
          updated_at?: string
          workspace_id: string
        }
        Update: {
          action?: string
          action_json?: Json
          confidence_threshold?: number
          created_at?: string
          description?: string | null
          enabled?: boolean
          examples?: string[]
          id?: string
          keywords?: string[]
          language?: string | null
          name?: string
          slug?: string
          system?: boolean
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_topics_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_workflows: {
        Row: {
          created_at: string
          description: string | null
          enabled: boolean
          id: string
          name: string
          status: string
          steps_json: Json
          trigger_json: Json
          updated_at: string
          version: number
          workspace_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          name: string
          status?: string
          steps_json?: Json
          trigger_json?: Json
          updated_at?: string
          version?: number
          workspace_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          name?: string
          status?: string
          steps_json?: Json
          trigger_json?: Json
          updated_at?: string
          version?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_workflows_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_billing_adjustments: {
        Row: {
          amount: number
          created_at: string
          created_by: string | null
          id: string
          ledger_entry_id: string | null
          reason: string
          run_id: string | null
          workspace_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          created_by?: string | null
          id?: string
          ledger_entry_id?: string | null
          reason: string
          run_id?: string | null
          workspace_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string | null
          id?: string
          ledger_entry_id?: string | null
          reason?: string
          run_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      ai_billing_audit_log: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          details: Json | null
          id: string
          target_ref: string | null
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          details?: Json | null
          id?: string
          target_ref?: string | null
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          details?: Json | null
          id?: string
          target_ref?: string | null
          workspace_id?: string | null
        }
        Relationships: []
      }
      ai_billing_commands: {
        Row: {
          command_type: string
          created_at: string
          id: string
          idempotency_key: string
          request_hash: string | null
          result_ref: string | null
          run_id: string | null
          state: string
          workspace_id: string | null
        }
        Insert: {
          command_type: string
          created_at?: string
          id?: string
          idempotency_key: string
          request_hash?: string | null
          result_ref?: string | null
          run_id?: string | null
          state?: string
          workspace_id?: string | null
        }
        Update: {
          command_type?: string
          created_at?: string
          id?: string
          idempotency_key?: string
          request_hash?: string | null
          result_ref?: string | null
          run_id?: string | null
          state?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      ai_billing_recovery_lease: {
        Row: {
          acquired_at: string | null
          expires_at: string | null
          id: boolean
          last_finished_at: string | null
          owner: string | null
          passes: number
        }
        Insert: {
          acquired_at?: string | null
          expires_at?: string | null
          id?: boolean
          last_finished_at?: string | null
          owner?: string | null
          passes?: number
        }
        Update: {
          acquired_at?: string | null
          expires_at?: string | null
          id?: boolean
          last_finished_at?: string | null
          owner?: string | null
          passes?: number
        }
        Relationships: []
      }
      ai_data_sources: {
        Row: {
          base_url: string | null
          chunks_created: number
          crawl_depth: number
          created_at: string
          embedded_chunks: number
          exclude_rules: Json
          id: string
          include_rules: Json
          last_error: string | null
          last_synced_at: string | null
          last_warning: string | null
          max_pages: number
          metadata: Json
          name: string
          next_sync_at: string | null
          pages_found: number
          refresh_interval: string
          source_type: string
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          base_url?: string | null
          chunks_created?: number
          crawl_depth?: number
          created_at?: string
          embedded_chunks?: number
          exclude_rules?: Json
          id?: string
          include_rules?: Json
          last_error?: string | null
          last_synced_at?: string | null
          last_warning?: string | null
          max_pages?: number
          metadata?: Json
          name: string
          next_sync_at?: string | null
          pages_found?: number
          refresh_interval?: string
          source_type: string
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          base_url?: string | null
          chunks_created?: number
          crawl_depth?: number
          created_at?: string
          embedded_chunks?: number
          exclude_rules?: Json
          id?: string
          include_rules?: Json
          last_error?: string | null
          last_synced_at?: string | null
          last_warning?: string | null
          max_pages?: number
          metadata?: Json
          name?: string
          next_sync_at?: string | null
          pages_found?: number
          refresh_interval?: string
          source_type?: string
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_data_sources_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_exchange_rates: {
        Row: {
          created_at: string
          created_by: string | null
          effective_from: string
          effective_to: string | null
          from_currency: string
          id: string
          rate: number
          to_currency: string
          version: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          effective_from?: string
          effective_to?: string | null
          from_currency: string
          id?: string
          rate: number
          to_currency: string
          version?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          effective_from?: string
          effective_to?: string | null
          from_currency?: string
          id?: string
          rate?: number
          to_currency?: string
          version?: number
        }
        Relationships: []
      }
      ai_kb_generated_articles: {
        Row: {
          confidence: number | null
          content_md: string
          created_at: string
          credits_used: number
          excerpt: string | null
          id: string
          job_id: string
          kb_article_id: string | null
          locale: string
          model: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          slug: string
          source_urls: Json
          status: Database["public"]["Enums"]["ai_kb_generated_status"]
          suggested_category: string | null
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          confidence?: number | null
          content_md?: string
          created_at?: string
          credits_used?: number
          excerpt?: string | null
          id?: string
          job_id: string
          kb_article_id?: string | null
          locale?: string
          model?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          slug: string
          source_urls?: Json
          status?: Database["public"]["Enums"]["ai_kb_generated_status"]
          suggested_category?: string | null
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          confidence?: number | null
          content_md?: string
          created_at?: string
          credits_used?: number
          excerpt?: string | null
          id?: string
          job_id?: string
          kb_article_id?: string | null
          locale?: string
          model?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          slug?: string
          source_urls?: Json
          status?: Database["public"]["Enums"]["ai_kb_generated_status"]
          suggested_category?: string | null
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_kb_generated_articles_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "ai_kb_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_kb_generated_articles_kb_article_id_fkey"
            columns: ["kb_article_id"]
            isOneToOne: false
            referencedRelation: "knowledge_base_articles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_kb_generated_articles_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_kb_job_events: {
        Row: {
          created_at: string
          id: string
          job_id: string
          level: string
          message: string
          metadata: Json
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          job_id: string
          level?: string
          message: string
          metadata?: Json
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          job_id?: string
          level?: string
          message?: string
          metadata?: Json
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_kb_job_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "ai_kb_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_kb_job_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_kb_job_pages: {
        Row: {
          bytes: number | null
          content_hash: string | null
          created_at: string
          depth: number
          error_message: string | null
          fetched_at: string | null
          http_status: number | null
          id: string
          job_id: string
          status: Database["public"]["Enums"]["ai_kb_page_status"]
          text_length: number | null
          title: string | null
          url: string
          url_hash: string
          workspace_id: string
        }
        Insert: {
          bytes?: number | null
          content_hash?: string | null
          created_at?: string
          depth?: number
          error_message?: string | null
          fetched_at?: string | null
          http_status?: number | null
          id?: string
          job_id: string
          status?: Database["public"]["Enums"]["ai_kb_page_status"]
          text_length?: number | null
          title?: string | null
          url: string
          url_hash: string
          workspace_id: string
        }
        Update: {
          bytes?: number | null
          content_hash?: string | null
          created_at?: string
          depth?: number
          error_message?: string | null
          fetched_at?: string | null
          http_status?: number | null
          id?: string
          job_id?: string
          status?: Database["public"]["Enums"]["ai_kb_page_status"]
          text_length?: number | null
          title?: string | null
          url?: string
          url_hash?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_kb_job_pages_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "ai_kb_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_kb_job_pages_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_kb_jobs: {
        Row: {
          admin_override: boolean
          articles_generated: number
          claimed_at: string | null
          completed_at: string | null
          created_at: string
          created_by_global_admin: string | null
          credits_used: number
          error_message: string | null
          id: string
          locale: string
          pages_crawled: number
          pages_discovered: number
          pages_failed: number
          plan_snapshot: Json
          progress: number
          requested_by: string | null
          source_domain: string
          source_kind: Database["public"]["Enums"]["ai_kb_source_kind"]
          source_verified: boolean
          source_workspace_domain_id: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["ai_kb_job_status"]
          updated_at: string
          worker_id: string | null
          workspace_id: string
        }
        Insert: {
          admin_override?: boolean
          articles_generated?: number
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          created_by_global_admin?: string | null
          credits_used?: number
          error_message?: string | null
          id?: string
          locale?: string
          pages_crawled?: number
          pages_discovered?: number
          pages_failed?: number
          plan_snapshot?: Json
          progress?: number
          requested_by?: string | null
          source_domain: string
          source_kind: Database["public"]["Enums"]["ai_kb_source_kind"]
          source_verified?: boolean
          source_workspace_domain_id?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["ai_kb_job_status"]
          updated_at?: string
          worker_id?: string | null
          workspace_id: string
        }
        Update: {
          admin_override?: boolean
          articles_generated?: number
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          created_by_global_admin?: string | null
          credits_used?: number
          error_message?: string | null
          id?: string
          locale?: string
          pages_crawled?: number
          pages_discovered?: number
          pages_failed?: number
          plan_snapshot?: Json
          progress?: number
          requested_by?: string | null
          source_domain?: string
          source_kind?: Database["public"]["Enums"]["ai_kb_source_kind"]
          source_verified?: boolean
          source_workspace_domain_id?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["ai_kb_job_status"]
          updated_at?: string
          worker_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_kb_jobs_source_workspace_domain_id_fkey"
            columns: ["source_workspace_domain_id"]
            isOneToOne: false
            referencedRelation: "workspace_domains"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_kb_jobs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_kb_usage: {
        Row: {
          created_at: string
          credits: number
          event_type: string
          generated_article_id: string | null
          id: string
          job_id: string | null
          metadata: Json
          workspace_id: string
        }
        Insert: {
          created_at?: string
          credits?: number
          event_type: string
          generated_article_id?: string | null
          id?: string
          job_id?: string | null
          metadata?: Json
          workspace_id: string
        }
        Update: {
          created_at?: string
          credits?: number
          event_type?: string
          generated_article_id?: string | null
          id?: string
          job_id?: string | null
          metadata?: Json
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_kb_usage_generated_article_id_fkey"
            columns: ["generated_article_id"]
            isOneToOne: false
            referencedRelation: "ai_kb_generated_articles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_kb_usage_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "ai_kb_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_kb_usage_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_knowledge_chunks: {
        Row: {
          chunk_index: number
          content: string
          content_hash: string
          created_at: string
          embedding: string | null
          embedding_model: string | null
          embedding_provider: string | null
          id: string
          locale: string | null
          metadata: Json
          source_id: string
          source_type: string
          source_url: string | null
          status: string
          title: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          chunk_index?: number
          content: string
          content_hash: string
          created_at?: string
          embedding?: string | null
          embedding_model?: string | null
          embedding_provider?: string | null
          id?: string
          locale?: string | null
          metadata?: Json
          source_id: string
          source_type: string
          source_url?: string | null
          status?: string
          title?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          chunk_index?: number
          content?: string
          content_hash?: string
          created_at?: string
          embedding?: string | null
          embedding_model?: string | null
          embedding_provider?: string | null
          id?: string
          locale?: string | null
          metadata?: Json
          source_id?: string
          source_type?: string
          source_url?: string | null
          status?: string
          title?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: []
      }
      ai_models: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          is_active: boolean
          model_key: string
          provider: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          is_active?: boolean
          model_key: string
          provider: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          is_active?: boolean
          model_key?: string
          provider?: string
          updated_at?: string
        }
        Relationships: []
      }
      ai_operator_assist_feedback: {
        Row: {
          assist_run_id: string
          comment: string | null
          conversation_id: string | null
          created_at: string
          final_composer_text: string | null
          id: string
          metadata: Json
          operator_action: string | null
          rating: string
          reason: string | null
          submitted_by: string | null
          workspace_id: string
        }
        Insert: {
          assist_run_id: string
          comment?: string | null
          conversation_id?: string | null
          created_at?: string
          final_composer_text?: string | null
          id?: string
          metadata?: Json
          operator_action?: string | null
          rating: string
          reason?: string | null
          submitted_by?: string | null
          workspace_id: string
        }
        Update: {
          assist_run_id?: string
          comment?: string | null
          conversation_id?: string | null
          created_at?: string
          final_composer_text?: string | null
          id?: string
          metadata?: Json
          operator_action?: string | null
          rating?: string
          reason?: string | null
          submitted_by?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_operator_assist_feedback_assist_run_id_fkey"
            columns: ["assist_run_id"]
            isOneToOne: false
            referencedRelation: "ai_operator_assist_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_operator_assist_runs: {
        Row: {
          answer_strategy: Json
          confidence: number | null
          conversation_id: string
          created_at: string
          error: string | null
          id: string
          input_message: string | null
          instruction: string | null
          model: string | null
          provider: string | null
          requested_by: string | null
          retrieval_debug: Json
          safety_notes: Json
          selected_sources: Json
          status: string
          suggestion: string | null
          tone: string | null
          workspace_id: string
        }
        Insert: {
          answer_strategy?: Json
          confidence?: number | null
          conversation_id: string
          created_at?: string
          error?: string | null
          id?: string
          input_message?: string | null
          instruction?: string | null
          model?: string | null
          provider?: string | null
          requested_by?: string | null
          retrieval_debug?: Json
          safety_notes?: Json
          selected_sources?: Json
          status: string
          suggestion?: string | null
          tone?: string | null
          workspace_id: string
        }
        Update: {
          answer_strategy?: Json
          confidence?: number | null
          conversation_id?: string
          created_at?: string
          error?: string | null
          id?: string
          input_message?: string | null
          instruction?: string | null
          model?: string | null
          provider?: string | null
          requested_by?: string | null
          retrieval_debug?: Json
          safety_notes?: Json
          selected_sources?: Json
          status?: string
          suggestion?: string | null
          tone?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      ai_rate_card_components: {
        Row: {
          component_type: string
          created_at: string
          id: string
          per_units: number
          rate_card_id: string
          unit: string
          unit_amount: number
        }
        Insert: {
          component_type: string
          created_at?: string
          id?: string
          per_units?: number
          rate_card_id: string
          unit?: string
          unit_amount?: number
        }
        Update: {
          component_type?: string
          created_at?: string
          id?: string
          per_units?: number
          rate_card_id?: string
          unit?: string
          unit_amount?: number
        }
        Relationships: [
          {
            foreignKeyName: "ai_rate_card_components_rate_card_id_fkey"
            columns: ["rate_card_id"]
            isOneToOne: false
            referencedRelation: "ai_rate_cards"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_rate_cards: {
        Row: {
          created_at: string
          created_by: string | null
          currency: string
          effective_from: string
          effective_to: string | null
          id: string
          model_key: string
          notes: string | null
          provider: string
          version: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          currency?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          model_key: string
          notes?: string | null
          provider: string
          version?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          currency?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          model_key?: string
          notes?: string | null
          provider?: string
          version?: number
        }
        Relationships: []
      }
      ai_run_settlements: {
        Row: {
          billing_cycle_id: string
          created_at: string
          customer_charge_irr: number
          id: string
          internal_cost_irr: number
          ledger_entry_id: string | null
          platform_absorbed_amount: number
          provider_cost_usd: number
          run_id: string
          workspace_id: string
        }
        Insert: {
          billing_cycle_id: string
          created_at?: string
          customer_charge_irr?: number
          id?: string
          internal_cost_irr?: number
          ledger_entry_id?: string | null
          platform_absorbed_amount?: number
          provider_cost_usd?: number
          run_id: string
          workspace_id: string
        }
        Update: {
          billing_cycle_id?: string
          created_at?: string
          customer_charge_irr?: number
          id?: string
          internal_cost_irr?: number
          ledger_entry_id?: string | null
          platform_absorbed_amount?: number
          provider_cost_usd?: number
          run_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_run_settlements_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "ai_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_run_steps: {
        Row: {
          actual_model: string | null
          attempt_no: number
          created_at: string
          id: string
          provider: string | null
          provider_request_id: string | null
          requested_model: string | null
          run_id: string
          state: string
          step_kind: string
          step_seq: number
        }
        Insert: {
          actual_model?: string | null
          attempt_no?: number
          created_at?: string
          id?: string
          provider?: string | null
          provider_request_id?: string | null
          requested_model?: string | null
          run_id: string
          state?: string
          step_kind: string
          step_seq?: number
        }
        Update: {
          actual_model?: string | null
          attempt_no?: number
          created_at?: string
          id?: string
          provider?: string | null
          provider_request_id?: string | null
          requested_model?: string | null
          run_id?: string
          state?: string
          step_kind?: string
          step_seq?: number
        }
        Relationships: [
          {
            foreignKeyName: "ai_run_steps_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "ai_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_runs: {
        Row: {
          billing_currency: string
          billing_fx_id: string | null
          billing_fx_rate: number | null
          billing_quality: string
          channel: string | null
          conversation_id: string | null
          cost_source: string
          created_at: string
          customer_charge_irr: number
          entry_point: string
          fallback_kind: string | null
          finished_at: string | null
          id: string
          internal_cost_irr: number
          mode: string
          operation_idempotency_key: string
          operation_request_hash: string
          overage_policy: string
          platform_absorbed_amount: number
          primary_model: string | null
          primary_provider: string | null
          provider_cost_usd: number
          reservation_id: string | null
          sell_multiplier: number | null
          sell_policy_id: string | null
          started_at: string
          status: string
          unresolved_reason: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          billing_currency?: string
          billing_fx_id?: string | null
          billing_fx_rate?: number | null
          billing_quality?: string
          channel?: string | null
          conversation_id?: string | null
          cost_source?: string
          created_at?: string
          customer_charge_irr?: number
          entry_point?: string
          fallback_kind?: string | null
          finished_at?: string | null
          id?: string
          internal_cost_irr?: number
          mode?: string
          operation_idempotency_key: string
          operation_request_hash: string
          overage_policy?: string
          platform_absorbed_amount?: number
          primary_model?: string | null
          primary_provider?: string | null
          provider_cost_usd?: number
          reservation_id?: string | null
          sell_multiplier?: number | null
          sell_policy_id?: string | null
          started_at?: string
          status?: string
          unresolved_reason?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          billing_currency?: string
          billing_fx_id?: string | null
          billing_fx_rate?: number | null
          billing_quality?: string
          channel?: string | null
          conversation_id?: string | null
          cost_source?: string
          created_at?: string
          customer_charge_irr?: number
          entry_point?: string
          fallback_kind?: string | null
          finished_at?: string | null
          id?: string
          internal_cost_irr?: number
          mode?: string
          operation_idempotency_key?: string
          operation_request_hash?: string
          overage_policy?: string
          platform_absorbed_amount?: number
          primary_model?: string | null
          primary_provider?: string | null
          provider_cost_usd?: number
          reservation_id?: string | null
          sell_multiplier?: number | null
          sell_policy_id?: string | null
          started_at?: string
          status?: string
          unresolved_reason?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_runs_billing_fx_id_fkey"
            columns: ["billing_fx_id"]
            isOneToOne: false
            referencedRelation: "ai_exchange_rates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_runs_sell_policy_id_fkey"
            columns: ["sell_policy_id"]
            isOneToOne: false
            referencedRelation: "ai_sell_policies"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_sell_policies: {
        Row: {
          created_at: string
          created_by: string | null
          effective_from: string
          effective_to: string | null
          id: string
          multiplier: number
          overage_policy: string
          scope: string
          version: number
          workspace_id: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          multiplier?: number
          overage_policy?: string
          scope?: string
          version?: number
          workspace_id?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          multiplier?: number
          overage_policy?: string
          scope?: string
          version?: number
          workspace_id?: string | null
        }
        Relationships: []
      }
      ai_source_pages: {
        Row: {
          chunks_created: number | null
          content_hash: string | null
          created_at: string
          embedding_status: string | null
          http_status: number | null
          id: string
          last_seen_at: string
          locale: string | null
          source_id: string
          status: string
          text_length: number | null
          title: string | null
          updated_at: string
          url: string
          url_hash: string
          warning: string | null
          workspace_id: string
        }
        Insert: {
          chunks_created?: number | null
          content_hash?: string | null
          created_at?: string
          embedding_status?: string | null
          http_status?: number | null
          id?: string
          last_seen_at?: string
          locale?: string | null
          source_id: string
          status?: string
          text_length?: number | null
          title?: string | null
          updated_at?: string
          url: string
          url_hash: string
          warning?: string | null
          workspace_id: string
        }
        Update: {
          chunks_created?: number | null
          content_hash?: string | null
          created_at?: string
          embedding_status?: string | null
          http_status?: number | null
          id?: string
          last_seen_at?: string
          locale?: string | null
          source_id?: string
          status?: string
          text_length?: number | null
          title?: string | null
          updated_at?: string
          url?: string
          url_hash?: string
          warning?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      ai_source_sync_jobs: {
        Row: {
          attempts: number
          created_at: string
          created_by: string | null
          finished_at: string | null
          id: string
          job_type: string
          last_error: string | null
          lock_expires_at: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          metadata: Json
          priority: number
          source_id: string
          started_at: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          created_by?: string | null
          finished_at?: string | null
          id?: string
          job_type?: string
          last_error?: string | null
          lock_expires_at?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          metadata?: Json
          priority?: number
          source_id: string
          started_at?: string | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          attempts?: number
          created_at?: string
          created_by?: string | null
          finished_at?: string | null
          id?: string
          job_type?: string
          last_error?: string | null
          lock_expires_at?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          metadata?: Json
          priority?: number
          source_id?: string
          started_at?: string | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: []
      }
      ai_source_sync_logs: {
        Row: {
          chunks_created: number | null
          created_at: string
          embedded_chunks: number | null
          errors: number | null
          id: string
          message: string | null
          metadata: Json
          pages_found: number | null
          source_id: string
          status: string
          workspace_id: string
        }
        Insert: {
          chunks_created?: number | null
          created_at?: string
          embedded_chunks?: number | null
          errors?: number | null
          id?: string
          message?: string | null
          metadata?: Json
          pages_found?: number | null
          source_id: string
          status: string
          workspace_id: string
        }
        Update: {
          chunks_created?: number | null
          created_at?: string
          embedded_chunks?: number | null
          errors?: number | null
          id?: string
          message?: string | null
          metadata?: Json
          pages_found?: number | null
          source_id?: string
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_source_sync_logs_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "ai_data_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_source_sync_logs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_usage_event_conflicts: {
        Row: {
          component_type: string
          conflicting_payload: Json | null
          conflicting_payload_hash: string | null
          created_at: string
          existing_event_id: string | null
          existing_payload_hash: string | null
          id: string
          resolved: boolean
          run_id: string
          step_id: string
          usage_event_key: string
        }
        Insert: {
          component_type: string
          conflicting_payload?: Json | null
          conflicting_payload_hash?: string | null
          created_at?: string
          existing_event_id?: string | null
          existing_payload_hash?: string | null
          id?: string
          resolved?: boolean
          run_id: string
          step_id: string
          usage_event_key: string
        }
        Update: {
          component_type?: string
          conflicting_payload?: Json | null
          conflicting_payload_hash?: string | null
          created_at?: string
          existing_event_id?: string | null
          existing_payload_hash?: string | null
          id?: string
          resolved?: boolean
          run_id?: string
          step_id?: string
          usage_event_key?: string
        }
        Relationships: []
      }
      ai_usage_events: {
        Row: {
          actual_model: string | null
          component_type: string
          created_at: string
          id: string
          internal_cost_irr: number
          payload_hash: string
          provider: string
          provider_cost_amount: number
          provider_cost_currency: string
          provider_cost_usd: number
          quantity: number
          rate_card_version_id: string | null
          raw_usage_json: Json | null
          requested_model: string | null
          run_id: string
          step_id: string
          unit: string
          usage_event_key: string
          usage_fx_id: string | null
          workspace_id: string
        }
        Insert: {
          actual_model?: string | null
          component_type: string
          created_at?: string
          id?: string
          internal_cost_irr?: number
          payload_hash: string
          provider: string
          provider_cost_amount?: number
          provider_cost_currency?: string
          provider_cost_usd?: number
          quantity?: number
          rate_card_version_id?: string | null
          raw_usage_json?: Json | null
          requested_model?: string | null
          run_id: string
          step_id: string
          unit?: string
          usage_event_key: string
          usage_fx_id?: string | null
          workspace_id: string
        }
        Update: {
          actual_model?: string | null
          component_type?: string
          created_at?: string
          id?: string
          internal_cost_irr?: number
          payload_hash?: string
          provider?: string
          provider_cost_amount?: number
          provider_cost_currency?: string
          provider_cost_usd?: number
          quantity?: number
          rate_card_version_id?: string | null
          raw_usage_json?: Json | null
          requested_model?: string | null
          run_id?: string
          step_id?: string
          unit?: string
          usage_event_key?: string
          usage_fx_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_events_rate_card_version_id_fkey"
            columns: ["rate_card_version_id"]
            isOneToOne: false
            referencedRelation: "ai_rate_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "ai_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_events_step_id_fkey"
            columns: ["step_id"]
            isOneToOne: false
            referencedRelation: "ai_run_steps"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_events_usage_fx_id_fkey"
            columns: ["usage_fx_id"]
            isOneToOne: false
            referencedRelation: "ai_exchange_rates"
            referencedColumns: ["id"]
          },
        ]
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
          workspace_id: string | null
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
          workspace_id?: string | null
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
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_user_id_profiles_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
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
          revoke_reason: string | null
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
          revoke_reason?: string | null
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
          revoke_reason?: string | null
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
      background_jobs: {
        Row: {
          attempts: number
          cancel_requested: boolean
          created_at: string
          created_by: string | null
          error_category: string | null
          error_message: string | null
          finished_at: string | null
          id: string
          job_type: string
          lock_expires_at: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          payload: Json
          priority: number
          progress: number
          progress_stage: string | null
          started_at: string | null
          status: string
          subject_id: string
          subject_type: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          attempts?: number
          cancel_requested?: boolean
          created_at?: string
          created_by?: string | null
          error_category?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          job_type: string
          lock_expires_at?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          progress?: number
          progress_stage?: string | null
          started_at?: string | null
          status?: string
          subject_id: string
          subject_type: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          attempts?: number
          cancel_requested?: boolean
          created_at?: string
          created_by?: string | null
          error_category?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          job_type?: string
          lock_expires_at?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          progress?: number
          progress_stage?: string | null
          started_at?: string | null
          status?: string
          subject_id?: string
          subject_type?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "background_jobs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_coupon_redemptions: {
        Row: {
          amount_minor: number
          coupon_id: string
          created_at: string
          currency: string
          id: string
          invoice_id: string | null
          workspace_id: string
        }
        Insert: {
          amount_minor?: number
          coupon_id: string
          created_at?: string
          currency?: string
          id?: string
          invoice_id?: string | null
          workspace_id: string
        }
        Update: {
          amount_minor?: number
          coupon_id?: string
          created_at?: string
          currency?: string
          id?: string
          invoice_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_coupon_redemptions_coupon_id_fkey"
            columns: ["coupon_id"]
            isOneToOne: false
            referencedRelation: "billing_coupons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_coupon_redemptions_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "billing_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_coupon_redemptions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_coupons: {
        Row: {
          amount_off_minor: number | null
          applies_to_plans: string[]
          code: string
          created_at: string
          currency: string | null
          description: string | null
          discount_type: string
          expires_at: string | null
          id: string
          is_active: boolean
          max_redemptions: number | null
          once_per_workspace: boolean
          percent_off: number | null
          redeemed_count: number
          starts_at: string | null
          updated_at: string
        }
        Insert: {
          amount_off_minor?: number | null
          applies_to_plans?: string[]
          code: string
          created_at?: string
          currency?: string | null
          description?: string | null
          discount_type?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          max_redemptions?: number | null
          once_per_workspace?: boolean
          percent_off?: number | null
          redeemed_count?: number
          starts_at?: string | null
          updated_at?: string
        }
        Update: {
          amount_off_minor?: number | null
          applies_to_plans?: string[]
          code?: string
          created_at?: string
          currency?: string | null
          description?: string | null
          discount_type?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          max_redemptions?: number | null
          once_per_workspace?: boolean
          percent_off?: number | null
          redeemed_count?: number
          starts_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_coupons_currency_fkey"
            columns: ["currency"]
            isOneToOne: false
            referencedRelation: "billing_currencies"
            referencedColumns: ["code"]
          },
        ]
      }
      billing_currencies: {
        Row: {
          code: string
          created_at: string
          display_name: Json
          is_active: boolean
          is_base: boolean
          minor_units: number
          sort_order: number
          symbol: string
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          display_name?: Json
          is_active?: boolean
          is_base?: boolean
          minor_units?: number
          sort_order?: number
          symbol?: string
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          display_name?: Json
          is_active?: boolean
          is_base?: boolean
          minor_units?: number
          sort_order?: number
          symbol?: string
          updated_at?: string
        }
        Relationships: []
      }
      billing_entitlement_cycles: {
        Row: {
          activated_at: string | null
          ai_allowance_irr: number
          allowance_granted_at: string | null
          allowance_lot_id: string | null
          allowance_state: string
          attempt_count: number
          billing_engine_version: string
          completed_at: string | null
          created_at: string
          cycle_end: string
          cycle_index: number
          cycle_start: string
          id: string
          last_error: string | null
          next_attempt_at: string
          snapshot: Json
          status: string
          subscription_id: string | null
          subscription_period_id: string
          workspace_id: string
        }
        Insert: {
          activated_at?: string | null
          ai_allowance_irr?: number
          allowance_granted_at?: string | null
          allowance_lot_id?: string | null
          allowance_state?: string
          attempt_count?: number
          billing_engine_version?: string
          completed_at?: string | null
          created_at?: string
          cycle_end: string
          cycle_index: number
          cycle_start: string
          id?: string
          last_error?: string | null
          next_attempt_at?: string
          snapshot?: Json
          status?: string
          subscription_id?: string | null
          subscription_period_id: string
          workspace_id: string
        }
        Update: {
          activated_at?: string | null
          ai_allowance_irr?: number
          allowance_granted_at?: string | null
          allowance_lot_id?: string | null
          allowance_state?: string
          attempt_count?: number
          billing_engine_version?: string
          completed_at?: string | null
          created_at?: string
          cycle_end?: string
          cycle_index?: number
          cycle_start?: string
          id?: string
          last_error?: string | null
          next_attempt_at?: string
          snapshot?: Json
          status?: string
          subscription_id?: string | null
          subscription_period_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_entitlement_cycles_subscription_period_id_fkey"
            columns: ["subscription_period_id"]
            isOneToOne: false
            referencedRelation: "billing_subscription_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_entitlement_cycles_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
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
      billing_exchange_rates: {
        Row: {
          base_code: string
          created_at: string
          effective_at: string
          id: string
          quote_code: string
          rate: number
        }
        Insert: {
          base_code: string
          created_at?: string
          effective_at?: string
          id?: string
          quote_code: string
          rate: number
        }
        Update: {
          base_code?: string
          created_at?: string
          effective_at?: string
          id?: string
          quote_code?: string
          rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "billing_exchange_rates_base_code_fkey"
            columns: ["base_code"]
            isOneToOne: false
            referencedRelation: "billing_currencies"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "billing_exchange_rates_quote_code_fkey"
            columns: ["quote_code"]
            isOneToOne: false
            referencedRelation: "billing_currencies"
            referencedColumns: ["code"]
          },
        ]
      }
      billing_gateways: {
        Row: {
          config: Json
          countries: string[]
          created_at: string
          currencies: string[]
          display_name: Json
          id: string
          is_active: boolean
          is_test: boolean
          provider_name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          config?: Json
          countries?: string[]
          created_at?: string
          currencies?: string[]
          display_name?: Json
          id?: string
          is_active?: boolean
          is_test?: boolean
          provider_name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          config?: Json
          countries?: string[]
          created_at?: string
          currencies?: string[]
          display_name?: Json
          id?: string
          is_active?: boolean
          is_test?: boolean
          provider_name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      billing_invoice_applications: {
        Row: {
          application_status: string
          application_type: string
          applied_at: string | null
          attempt_count: number
          created_at: string
          id: string
          invoice_id: string
          last_error: string | null
          lease_until: string | null
          next_attempt_at: string
          period_id: string | null
          result_snapshot: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          application_status?: string
          application_type: string
          applied_at?: string | null
          attempt_count?: number
          created_at?: string
          id?: string
          invoice_id: string
          last_error?: string | null
          lease_until?: string | null
          next_attempt_at?: string
          period_id?: string | null
          result_snapshot?: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          application_status?: string
          application_type?: string
          applied_at?: string | null
          attempt_count?: number
          created_at?: string
          id?: string
          invoice_id?: string
          last_error?: string | null
          lease_until?: string | null
          next_attempt_at?: string
          period_id?: string | null
          result_snapshot?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_invoice_applications_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "billing_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_invoice_applications_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "billing_subscription_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_invoice_applications_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_invoice_collections: {
        Row: {
          amount_irr: number
          channel: string
          command_key: string
          created_at: string
          expires_at: string
          id: string
          invoice_id: string
          payment_intent_id: string | null
          release_reason: string | null
          released_at: string | null
          status: string
          workspace_id: string
        }
        Insert: {
          amount_irr: number
          channel: string
          command_key: string
          created_at?: string
          expires_at: string
          id?: string
          invoice_id: string
          payment_intent_id?: string | null
          release_reason?: string | null
          released_at?: string | null
          status?: string
          workspace_id: string
        }
        Update: {
          amount_irr?: number
          channel?: string
          command_key?: string
          created_at?: string
          expires_at?: string
          id?: string
          invoice_id?: string
          payment_intent_id?: string | null
          release_reason?: string | null
          released_at?: string | null
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_invoice_collections_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "billing_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_invoice_collections_payment_intent_id_fkey"
            columns: ["payment_intent_id"]
            isOneToOne: false
            referencedRelation: "billing_payment_intents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_invoice_collections_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_invoice_lines: {
        Row: {
          amount_irr: number
          created_at: string
          description: string
          id: string
          invoice_id: string
          line_type: string
          metadata: Json
          plan_id: string | null
          quantity: number
          sort_order: number
          unit_amount_irr: number
        }
        Insert: {
          amount_irr?: number
          created_at?: string
          description: string
          id?: string
          invoice_id: string
          line_type: string
          metadata?: Json
          plan_id?: string | null
          quantity?: number
          sort_order?: number
          unit_amount_irr?: number
        }
        Update: {
          amount_irr?: number
          created_at?: string
          description?: string
          id?: string
          invoice_id?: string
          line_type?: string
          metadata?: Json
          plan_id?: string | null
          quantity?: number
          sort_order?: number
          unit_amount_irr?: number
        }
        Relationships: [
          {
            foreignKeyName: "billing_invoice_lines_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "billing_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_invoice_lines_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_invoice_lines_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans_public"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_invoices: {
        Row: {
          amount_due_irr: number
          amount_paid_irr: number
          billing_engine_version: string
          billing_interval: string | null
          coupon_code: string | null
          coupon_id: string | null
          created_at: string
          currency: string
          discount_irr: number
          document_type: string
          due_at: string | null
          effect_snapshot: Json | null
          id: string
          invoice_number: string
          invoice_type: string
          issued_at: string | null
          metadata: Json
          paid_at: string | null
          past_due_at: string | null
          period_end: string | null
          period_start: string | null
          plan_id: string | null
          plan_name_snapshot: string | null
          status: string
          subscription_id: string | null
          subtotal_irr: number
          tax_irr: number
          tax_rate_percent: number
          total_irr: number
          updated_at: string
          voided_at: string | null
          workspace_id: string
        }
        Insert: {
          amount_due_irr?: number
          amount_paid_irr?: number
          billing_engine_version?: string
          billing_interval?: string | null
          coupon_code?: string | null
          coupon_id?: string | null
          created_at?: string
          currency?: string
          discount_irr?: number
          document_type?: string
          due_at?: string | null
          effect_snapshot?: Json | null
          id?: string
          invoice_number: string
          invoice_type: string
          issued_at?: string | null
          metadata?: Json
          paid_at?: string | null
          past_due_at?: string | null
          period_end?: string | null
          period_start?: string | null
          plan_id?: string | null
          plan_name_snapshot?: string | null
          status?: string
          subscription_id?: string | null
          subtotal_irr?: number
          tax_irr?: number
          tax_rate_percent?: number
          total_irr?: number
          updated_at?: string
          voided_at?: string | null
          workspace_id: string
        }
        Update: {
          amount_due_irr?: number
          amount_paid_irr?: number
          billing_engine_version?: string
          billing_interval?: string | null
          coupon_code?: string | null
          coupon_id?: string | null
          created_at?: string
          currency?: string
          discount_irr?: number
          document_type?: string
          due_at?: string | null
          effect_snapshot?: Json | null
          id?: string
          invoice_number?: string
          invoice_type?: string
          issued_at?: string | null
          metadata?: Json
          paid_at?: string | null
          past_due_at?: string | null
          period_end?: string | null
          period_start?: string | null
          plan_id?: string | null
          plan_name_snapshot?: string | null
          status?: string
          subscription_id?: string | null
          subtotal_irr?: number
          tax_irr?: number
          tax_rate_percent?: number
          total_irr?: number
          updated_at?: string
          voided_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_invoices_coupon_id_fkey"
            columns: ["coupon_id"]
            isOneToOne: false
            referencedRelation: "billing_coupons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_invoices_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_invoices_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_invoices_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "workspace_subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_invoices_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_notification_jobs: {
        Row: {
          attempt_count: number
          channel: string
          created_at: string
          id: string
          idempotency_key: string
          invoice_id: string | null
          last_error: string | null
          lease_until: string | null
          locale: string | null
          max_attempts: number
          next_attempt_at: string
          notification_type: string
          payload: Json
          scheduled_at: string
          sent_at: string | null
          status: string
          subscription_id: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          attempt_count?: number
          channel: string
          created_at?: string
          id?: string
          idempotency_key: string
          invoice_id?: string | null
          last_error?: string | null
          lease_until?: string | null
          locale?: string | null
          max_attempts?: number
          next_attempt_at?: string
          notification_type: string
          payload?: Json
          scheduled_at?: string
          sent_at?: string | null
          status?: string
          subscription_id?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          attempt_count?: number
          channel?: string
          created_at?: string
          id?: string
          idempotency_key?: string
          invoice_id?: string | null
          last_error?: string | null
          lease_until?: string | null
          locale?: string | null
          max_attempts?: number
          next_attempt_at?: string
          notification_type?: string
          payload?: Json
          scheduled_at?: string
          sent_at?: string | null
          status?: string
          subscription_id?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_notification_jobs_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "billing_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_notification_jobs_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "workspace_subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_notification_jobs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_payment_allocations: {
        Row: {
          amount_irr: number
          command_key: string
          created_at: string
          id: string
          invoice_id: string
          payment_id: string | null
          wallet_ledger_entry_id: string | null
          workspace_id: string
        }
        Insert: {
          amount_irr: number
          command_key: string
          created_at?: string
          id?: string
          invoice_id: string
          payment_id?: string | null
          wallet_ledger_entry_id?: string | null
          workspace_id: string
        }
        Update: {
          amount_irr?: number
          command_key?: string
          created_at?: string
          id?: string
          invoice_id?: string
          payment_id?: string | null
          wallet_ledger_entry_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_payment_allocations_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "billing_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_payment_allocations_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "billing_payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_payment_allocations_wallet_ledger_entry_id_fkey"
            columns: ["wallet_ledger_entry_id"]
            isOneToOne: false
            referencedRelation: "billing_wallet_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_payment_allocations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_payment_intents: {
        Row: {
          action_type: string | null
          amount_irr: number
          attempt_count: number
          billing_engine_version: string
          billing_interval: string | null
          created_at: string
          discount_irr: number
          expected_amount_irr: number | null
          expires_at: string
          failure_reason: string | null
          final_amount_irr: number | null
          id: string
          invoice_id: string | null
          invoice_number: string | null
          metadata: Json
          period_end: string | null
          period_start: string | null
          plan_id: string | null
          plan_name_snapshot: string | null
          processing_at: string | null
          provider_name: string
          provider_ref: string | null
          purchase_type: string
          status: string
          succeeded_at: string | null
          updated_at: string
          wallet_deposit_id: string | null
          workspace_id: string
          workspace_name_snapshot: string | null
        }
        Insert: {
          action_type?: string | null
          amount_irr: number
          attempt_count?: number
          billing_engine_version?: string
          billing_interval?: string | null
          created_at?: string
          discount_irr?: number
          expected_amount_irr?: number | null
          expires_at?: string
          failure_reason?: string | null
          final_amount_irr?: number | null
          id?: string
          invoice_id?: string | null
          invoice_number?: string | null
          metadata?: Json
          period_end?: string | null
          period_start?: string | null
          plan_id?: string | null
          plan_name_snapshot?: string | null
          processing_at?: string | null
          provider_name: string
          provider_ref?: string | null
          purchase_type: string
          status?: string
          succeeded_at?: string | null
          updated_at?: string
          wallet_deposit_id?: string | null
          workspace_id: string
          workspace_name_snapshot?: string | null
        }
        Update: {
          action_type?: string | null
          amount_irr?: number
          attempt_count?: number
          billing_engine_version?: string
          billing_interval?: string | null
          created_at?: string
          discount_irr?: number
          expected_amount_irr?: number | null
          expires_at?: string
          failure_reason?: string | null
          final_amount_irr?: number | null
          id?: string
          invoice_id?: string | null
          invoice_number?: string | null
          metadata?: Json
          period_end?: string | null
          period_start?: string | null
          plan_id?: string | null
          plan_name_snapshot?: string | null
          processing_at?: string | null
          provider_name?: string
          provider_ref?: string | null
          purchase_type?: string
          status?: string
          succeeded_at?: string | null
          updated_at?: string
          wallet_deposit_id?: string | null
          workspace_id?: string
          workspace_name_snapshot?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_payment_intents_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "billing_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_payment_intents_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_payment_intents_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_payment_intents_wallet_deposit_fkey"
            columns: ["wallet_deposit_id"]
            isOneToOne: false
            referencedRelation: "billing_wallet_deposits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_payment_intents_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_payments: {
        Row: {
          action_type: string | null
          amount: number
          billing_interval: string | null
          created_at: string | null
          currency: string
          id: string
          invoice_id: string | null
          invoice_number: string | null
          metadata: Json | null
          paid_at: string | null
          payment_intent_id: string | null
          plan_id: string | null
          plan_name_snapshot: string | null
          provider_name: string
          provider_payment_id: string | null
          purchase_type: string | null
          reconciliation_reason: string | null
          reconciliation_state: string
          refund_amount: number | null
          status: string
          workspace_id: string
        }
        Insert: {
          action_type?: string | null
          amount?: number
          billing_interval?: string | null
          created_at?: string | null
          currency?: string
          id?: string
          invoice_id?: string | null
          invoice_number?: string | null
          metadata?: Json | null
          paid_at?: string | null
          payment_intent_id?: string | null
          plan_id?: string | null
          plan_name_snapshot?: string | null
          provider_name: string
          provider_payment_id?: string | null
          purchase_type?: string | null
          reconciliation_reason?: string | null
          reconciliation_state?: string
          refund_amount?: number | null
          status?: string
          workspace_id: string
        }
        Update: {
          action_type?: string | null
          amount?: number
          billing_interval?: string | null
          created_at?: string | null
          currency?: string
          id?: string
          invoice_id?: string | null
          invoice_number?: string | null
          metadata?: Json | null
          paid_at?: string | null
          payment_intent_id?: string | null
          plan_id?: string | null
          plan_name_snapshot?: string | null
          provider_name?: string
          provider_payment_id?: string | null
          purchase_type?: string | null
          reconciliation_reason?: string | null
          reconciliation_state?: string
          refund_amount?: number | null
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "billing_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_payments_payment_intent_id_fkey"
            columns: ["payment_intent_id"]
            isOneToOne: false
            referencedRelation: "billing_payment_intents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_payments_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_payments_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_payments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_period_allowance_grants: {
        Row: {
          allowance_irr: number
          attempt_count: number
          created_at: string
          granted_at: string | null
          last_error: string | null
          lot_id: string | null
          next_attempt_at: string
          period_id: string
          status: string
          workspace_id: string
        }
        Insert: {
          allowance_irr?: number
          attempt_count?: number
          created_at?: string
          granted_at?: string | null
          last_error?: string | null
          lot_id?: string | null
          next_attempt_at?: string
          period_id: string
          status?: string
          workspace_id: string
        }
        Update: {
          allowance_irr?: number
          attempt_count?: number
          created_at?: string
          granted_at?: string | null
          last_error?: string | null
          lot_id?: string | null
          next_attempt_at?: string
          period_id?: string
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_period_allowance_grants_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: true
            referencedRelation: "billing_subscription_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_period_allowance_grants_workspace_id_fkey"
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
          is_hidden: boolean
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
          is_hidden?: boolean
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
          is_hidden?: boolean
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
      billing_retention_signals: {
        Row: {
          cleared_at: string | null
          details: Json
          reason: string
          signaled_at: string
          state: string
          workspace_id: string
        }
        Insert: {
          cleared_at?: string | null
          details?: Json
          reason: string
          signaled_at?: string
          state?: string
          workspace_id: string
        }
        Update: {
          cleared_at?: string | null
          details?: Json
          reason?: string
          signaled_at?: string
          state?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_retention_signals_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_subscription_applications: {
        Row: {
          action_type: string
          applied_at: string
          billing_interval: string
          created_at: string
          id: string
          payment_intent_id: string
          period_end: string
          period_start: string
          plan_id: string | null
          provider_name: string | null
          stacked: boolean
          workspace_id: string
        }
        Insert: {
          action_type: string
          applied_at?: string
          billing_interval: string
          created_at?: string
          id?: string
          payment_intent_id: string
          period_end: string
          period_start: string
          plan_id?: string | null
          provider_name?: string | null
          stacked?: boolean
          workspace_id: string
        }
        Update: {
          action_type?: string
          applied_at?: string
          billing_interval?: string
          created_at?: string
          id?: string
          payment_intent_id?: string
          period_end?: string
          period_start?: string
          plan_id?: string | null
          provider_name?: string | null
          stacked?: boolean
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_subscription_applications_payment_intent_id_fkey"
            columns: ["payment_intent_id"]
            isOneToOne: false
            referencedRelation: "billing_payment_intents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_subscription_applications_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_subscription_applications_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_subscription_applications_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_subscription_periods: {
        Row: {
          activated_at: string | null
          ai_allowance_irr: number
          billing_engine_version: string
          billing_interval: string
          completed_at: string | null
          created_at: string
          id: string
          invoice_id: string | null
          limits_snapshot: Json
          period_end: string
          period_start: string
          plan_id: string | null
          plan_snapshot: Json
          source: string
          status: string
          subscription_id: string | null
          workspace_id: string
        }
        Insert: {
          activated_at?: string | null
          ai_allowance_irr?: number
          billing_engine_version?: string
          billing_interval?: string
          completed_at?: string | null
          created_at?: string
          id?: string
          invoice_id?: string | null
          limits_snapshot?: Json
          period_end: string
          period_start: string
          plan_id?: string | null
          plan_snapshot?: Json
          source?: string
          status?: string
          subscription_id?: string | null
          workspace_id: string
        }
        Update: {
          activated_at?: string | null
          ai_allowance_irr?: number
          billing_engine_version?: string
          billing_interval?: string
          completed_at?: string | null
          created_at?: string
          id?: string
          invoice_id?: string | null
          limits_snapshot?: Json
          period_end?: string
          period_start?: string
          plan_id?: string | null
          plan_snapshot?: Json
          source?: string
          status?: string
          subscription_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_subscription_periods_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "billing_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_subscription_periods_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_subscription_periods_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_subscription_periods_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "workspace_subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_subscription_periods_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_tax_rates: {
        Row: {
          country_code: string | null
          created_at: string
          currency: string | null
          id: string
          is_active: boolean
          is_inclusive: boolean
          name: string
          rate_percent: number
          updated_at: string
        }
        Insert: {
          country_code?: string | null
          created_at?: string
          currency?: string | null
          id?: string
          is_active?: boolean
          is_inclusive?: boolean
          name: string
          rate_percent?: number
          updated_at?: string
        }
        Update: {
          country_code?: string | null
          created_at?: string
          currency?: string | null
          id?: string
          is_active?: boolean
          is_inclusive?: boolean
          name?: string
          rate_percent?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_tax_rates_currency_fkey"
            columns: ["currency"]
            isOneToOne: false
            referencedRelation: "billing_currencies"
            referencedColumns: ["code"]
          },
        ]
      }
      billing_usage_items: {
        Row: {
          created_at: string
          display_name: Json
          is_active: boolean
          key: string
          prices: Json
          sort_order: number
          unit: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: Json
          is_active?: boolean
          key: string
          prices?: Json
          sort_order?: number
          unit?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: Json
          is_active?: boolean
          key?: string
          prices?: Json
          sort_order?: number
          unit?: string
          updated_at?: string
        }
        Relationships: []
      }
      billing_v2_audit: {
        Row: {
          actor_id: string | null
          created_at: string
          details: Json
          event: string
          id: string
          reason: string | null
          workspace_id: string | null
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          details?: Json
          event: string
          id?: string
          reason?: string | null
          workspace_id?: string | null
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          details?: Json
          event?: string
          id?: string
          reason?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_v2_audit_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_v2_jobs: {
        Row: {
          attempt_count: number
          created_at: string
          dedupe_key: string
          id: string
          job_type: string
          last_error: string | null
          lease_until: string | null
          max_attempts: number
          next_attempt_at: string
          payload: Json
          result: Json | null
          status: string
          updated_at: string
          workspace_id: string | null
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          dedupe_key: string
          id?: string
          job_type: string
          last_error?: string | null
          lease_until?: string | null
          max_attempts?: number
          next_attempt_at?: string
          payload?: Json
          result?: Json | null
          status?: string
          updated_at?: string
          workspace_id?: string | null
        }
        Update: {
          attempt_count?: number
          created_at?: string
          dedupe_key?: string
          id?: string
          job_type?: string
          last_error?: string | null
          lease_until?: string | null
          max_attempts?: number
          next_attempt_at?: string
          payload?: Json
          result?: Json | null
          status?: string
          updated_at?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_v2_jobs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_v2_policy: {
        Row: {
          collection_ttl_seconds: number
          fallback_plan_id: string | null
          grace_period_days: number
          id: boolean
          invoice_due_offset_days: number
          invoice_lead_time_days: number
          new_workspace_default_region: string | null
          new_workspace_default_state: string
          notification_max_attempts: number
          notification_max_per_hour: number
          notification_retry_seconds: number
          notify_on_due: boolean
          notify_on_fallback: boolean
          notify_on_past_due: boolean
          reminder_days_before_due: number[]
          send_invoice_issued_email: boolean
          send_invoice_issued_sms: boolean
          updated_at: string
          wallet_auto_pay_default: boolean
          wallet_deposit_allow_custom: boolean
          wallet_deposit_max_irr: number
          wallet_deposit_min_irr: number
          wallet_deposit_presets_irr: number[]
        }
        Insert: {
          collection_ttl_seconds?: number
          fallback_plan_id?: string | null
          grace_period_days?: number
          id?: boolean
          invoice_due_offset_days?: number
          invoice_lead_time_days?: number
          new_workspace_default_region?: string | null
          new_workspace_default_state?: string
          notification_max_attempts?: number
          notification_max_per_hour?: number
          notification_retry_seconds?: number
          notify_on_due?: boolean
          notify_on_fallback?: boolean
          notify_on_past_due?: boolean
          reminder_days_before_due?: number[]
          send_invoice_issued_email?: boolean
          send_invoice_issued_sms?: boolean
          updated_at?: string
          wallet_auto_pay_default?: boolean
          wallet_deposit_allow_custom?: boolean
          wallet_deposit_max_irr?: number
          wallet_deposit_min_irr?: number
          wallet_deposit_presets_irr?: number[]
        }
        Update: {
          collection_ttl_seconds?: number
          fallback_plan_id?: string | null
          grace_period_days?: number
          id?: boolean
          invoice_due_offset_days?: number
          invoice_lead_time_days?: number
          new_workspace_default_region?: string | null
          new_workspace_default_state?: string
          notification_max_attempts?: number
          notification_max_per_hour?: number
          notification_retry_seconds?: number
          notify_on_due?: boolean
          notify_on_fallback?: boolean
          notify_on_past_due?: boolean
          reminder_days_before_due?: number[]
          send_invoice_issued_email?: boolean
          send_invoice_issued_sms?: boolean
          updated_at?: string
          wallet_auto_pay_default?: boolean
          wallet_deposit_allow_custom?: boolean
          wallet_deposit_max_irr?: number
          wallet_deposit_min_irr?: number
          wallet_deposit_presets_irr?: number[]
        }
        Relationships: [
          {
            foreignKeyName: "billing_v2_policy_fallback_plan_id_fkey"
            columns: ["fallback_plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_v2_policy_fallback_plan_id_fkey"
            columns: ["fallback_plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans_public"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_v2_rollout: {
        Row: {
          activated_at: string | null
          activated_by: string | null
          created_at: string
          cutover_pending_at: string | null
          last_blockers: Json
          region: string | null
          shadow_enabled_at: string | null
          state: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          activated_at?: string | null
          activated_by?: string | null
          created_at?: string
          cutover_pending_at?: string | null
          last_blockers?: Json
          region?: string | null
          shadow_enabled_at?: string | null
          state?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          activated_at?: string | null
          activated_by?: string | null
          created_at?: string
          cutover_pending_at?: string | null
          last_blockers?: Json
          region?: string | null
          shadow_enabled_at?: string | null
          state?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_v2_rollout_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_v2_worker_health: {
        Row: {
          consecutive_failures: number
          last_batch_size: number
          last_error: string | null
          last_failure_at: string | null
          last_run_at: string | null
          last_success_at: string | null
          updated_at: string
          worker: string
        }
        Insert: {
          consecutive_failures?: number
          last_batch_size?: number
          last_error?: string | null
          last_failure_at?: string | null
          last_run_at?: string | null
          last_success_at?: string | null
          updated_at?: string
          worker: string
        }
        Update: {
          consecutive_failures?: number
          last_batch_size?: number
          last_error?: string | null
          last_failure_at?: string | null
          last_run_at?: string | null
          last_success_at?: string | null
          updated_at?: string
          worker?: string
        }
        Relationships: []
      }
      billing_v2_workspace_policy: {
        Row: {
          invoice_lead_time_days: number | null
          notifications_enabled: boolean | null
          reminder_days_before_due: number[] | null
          send_invoice_issued_sms: boolean | null
          updated_at: string
          wallet_auto_pay_enabled: boolean | null
          workspace_id: string
        }
        Insert: {
          invoice_lead_time_days?: number | null
          notifications_enabled?: boolean | null
          reminder_days_before_due?: number[] | null
          send_invoice_issued_sms?: boolean | null
          updated_at?: string
          wallet_auto_pay_enabled?: boolean | null
          workspace_id: string
        }
        Update: {
          invoice_lead_time_days?: number | null
          notifications_enabled?: boolean | null
          reminder_days_before_due?: number[] | null
          send_invoice_issued_sms?: boolean | null
          updated_at?: string
          wallet_auto_pay_enabled?: boolean | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_v2_workspace_policy_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_wallet_accounts: {
        Row: {
          auto_pay_enabled: boolean | null
          available_balance_irr: number
          created_at: string
          currency: string
          frozen: boolean
          id: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          auto_pay_enabled?: boolean | null
          available_balance_irr?: number
          created_at?: string
          currency?: string
          frozen?: boolean
          id?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          auto_pay_enabled?: boolean | null
          available_balance_irr?: number
          created_at?: string
          currency?: string
          frozen?: boolean
          id?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_wallet_accounts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_wallet_deposits: {
        Row: {
          amount_irr: number
          billing_engine_version: string
          created_at: string
          currency: string
          document_number: string
          document_type: string
          id: string
          metadata: Json
          paid_at: string | null
          payment_id: string | null
          payment_intent_id: string | null
          status: string
          workspace_id: string
        }
        Insert: {
          amount_irr: number
          billing_engine_version?: string
          created_at?: string
          currency?: string
          document_number: string
          document_type?: string
          id?: string
          metadata?: Json
          paid_at?: string | null
          payment_id?: string | null
          payment_intent_id?: string | null
          status?: string
          workspace_id: string
        }
        Update: {
          amount_irr?: number
          billing_engine_version?: string
          created_at?: string
          currency?: string
          document_number?: string
          document_type?: string
          id?: string
          metadata?: Json
          paid_at?: string | null
          payment_id?: string | null
          payment_intent_id?: string | null
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_wallet_deposits_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "billing_payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_wallet_deposits_payment_intent_id_fkey"
            columns: ["payment_intent_id"]
            isOneToOne: false
            referencedRelation: "billing_payment_intents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_wallet_deposits_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_wallet_ledger: {
        Row: {
          actor_id: string | null
          amount_irr: number
          balance_after_irr: number
          command_key: string
          created_at: string
          entry_type: string
          id: string
          invoice_id: string | null
          metadata: Json
          payment_id: string | null
          reason: string | null
          wallet_deposit_id: string | null
          workspace_id: string
        }
        Insert: {
          actor_id?: string | null
          amount_irr: number
          balance_after_irr: number
          command_key: string
          created_at?: string
          entry_type: string
          id?: string
          invoice_id?: string | null
          metadata?: Json
          payment_id?: string | null
          reason?: string | null
          wallet_deposit_id?: string | null
          workspace_id: string
        }
        Update: {
          actor_id?: string | null
          amount_irr?: number
          balance_after_irr?: number
          command_key?: string
          created_at?: string
          entry_type?: string
          id?: string
          invoice_id?: string | null
          metadata?: Json
          payment_id?: string | null
          reason?: string | null
          wallet_deposit_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_wallet_ledger_deposit_fkey"
            columns: ["wallet_deposit_id"]
            isOneToOne: false
            referencedRelation: "billing_wallet_deposits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_wallet_ledger_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "billing_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_wallet_ledger_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "billing_payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_wallet_ledger_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      business_metrics_hourly: {
        Row: {
          active_conversations: number
          active_operators: number
          avg_conversation_duration_seconds: number | null
          avg_messages_per_conversation: number | null
          avg_resolution_time_seconds: number | null
          bucket_hour: string
          conversation_to_resolution_rate: number | null
          first_response_time_p50: number | null
          first_response_time_p95: number | null
          messages_sent: number
          new_conversations: number
          next_response_time_p50: number | null
          next_response_time_p95: number | null
          reopened_conversations: number
          resolved_conversations: number
          stale_open_conversations: number
          support_load_score: number | null
          unanswered_conversations: number
          visitor_to_conversation_rate: number | null
          workspace_id: string
        }
        Insert: {
          active_conversations?: number
          active_operators?: number
          avg_conversation_duration_seconds?: number | null
          avg_messages_per_conversation?: number | null
          avg_resolution_time_seconds?: number | null
          bucket_hour: string
          conversation_to_resolution_rate?: number | null
          first_response_time_p50?: number | null
          first_response_time_p95?: number | null
          messages_sent?: number
          new_conversations?: number
          next_response_time_p50?: number | null
          next_response_time_p95?: number | null
          reopened_conversations?: number
          resolved_conversations?: number
          stale_open_conversations?: number
          support_load_score?: number | null
          unanswered_conversations?: number
          visitor_to_conversation_rate?: number | null
          workspace_id: string
        }
        Update: {
          active_conversations?: number
          active_operators?: number
          avg_conversation_duration_seconds?: number | null
          avg_messages_per_conversation?: number | null
          avg_resolution_time_seconds?: number | null
          bucket_hour?: string
          conversation_to_resolution_rate?: number | null
          first_response_time_p50?: number | null
          first_response_time_p95?: number | null
          messages_sent?: number
          new_conversations?: number
          next_response_time_p50?: number | null
          next_response_time_p95?: number | null
          reopened_conversations?: number
          resolved_conversations?: number
          stale_open_conversations?: number
          support_load_score?: number | null
          unanswered_conversations?: number
          visitor_to_conversation_rate?: number | null
          workspace_id?: string
        }
        Relationships: []
      }
      call_center_agent_presence: {
        Row: {
          active_call_count: number
          created_at: string
          id: string
          last_seen_at: string | null
          metadata: Json
          status: string
          status_message: string | null
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          active_call_count?: number
          created_at?: string
          id?: string
          last_seen_at?: string | null
          metadata?: Json
          status?: string
          status_message?: string | null
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          active_call_count?: number
          created_at?: string
          id?: string
          last_seen_at?: string | null
          metadata?: Json
          status?: string
          status_message?: string | null
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_center_agent_presence_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      call_center_department_agents: {
        Row: {
          created_at: string
          department_id: string
          enabled: boolean
          id: string
          max_concurrent_calls: number | null
          metadata: Json
          priority: number
          role: string
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          department_id: string
          enabled?: boolean
          id?: string
          max_concurrent_calls?: number | null
          metadata?: Json
          priority?: number
          role?: string
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          department_id?: string
          enabled?: boolean
          id?: string
          max_concurrent_calls?: number | null
          metadata?: Json
          priority?: number
          role?: string
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_center_department_agents_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "call_center_departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_center_department_agents_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      call_center_departments: {
        Row: {
          color: string | null
          created_at: string
          description: string | null
          enabled: boolean
          fallback_department_id: string | null
          icon: string | null
          id: string
          metadata: Json
          name: string
          routing_mode: string
          slug: string
          sort_order: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          description?: string | null
          enabled?: boolean
          fallback_department_id?: string | null
          icon?: string | null
          id?: string
          metadata?: Json
          name: string
          routing_mode?: string
          slug: string
          sort_order?: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          color?: string | null
          created_at?: string
          description?: string | null
          enabled?: boolean
          fallback_department_id?: string | null
          icon?: string | null
          id?: string
          metadata?: Json
          name?: string
          routing_mode?: string
          slug?: string
          sort_order?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_center_departments_fallback_fk"
            columns: ["fallback_department_id"]
            isOneToOne: false
            referencedRelation: "call_center_departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_center_departments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      call_center_settings: {
        Row: {
          allow_visitor_department_choice: boolean
          allowed_domains: string[]
          avatar_storage_path: string | null
          avatar_url: string | null
          business_hours: Json
          callback_enabled: boolean
          created_at: string
          default_department_id: string | null
          departments_enabled: boolean
          display_name: string | null
          enabled: boolean
          id: string
          offline_behavior: string
          operator_video_visible_to_visitor: boolean
          pre_call_form_enabled: boolean
          pre_call_form_schema: Json
          public_key: string | null
          recording_consent_required: boolean
          recording_enabled: boolean
          routing_mode: string
          updated_at: string
          video_enabled: boolean
          voice_enabled: boolean
          widget_custom_texts: Json
          widget_default_locale: string | null
          widget_enabled_locales: string[] | null
          widget_position: string
          widget_theme: Json
          workspace_id: string
        }
        Insert: {
          allow_visitor_department_choice?: boolean
          allowed_domains?: string[]
          avatar_storage_path?: string | null
          avatar_url?: string | null
          business_hours?: Json
          callback_enabled?: boolean
          created_at?: string
          default_department_id?: string | null
          departments_enabled?: boolean
          display_name?: string | null
          enabled?: boolean
          id?: string
          offline_behavior?: string
          operator_video_visible_to_visitor?: boolean
          pre_call_form_enabled?: boolean
          pre_call_form_schema?: Json
          public_key?: string | null
          recording_consent_required?: boolean
          recording_enabled?: boolean
          routing_mode?: string
          updated_at?: string
          video_enabled?: boolean
          voice_enabled?: boolean
          widget_custom_texts?: Json
          widget_default_locale?: string | null
          widget_enabled_locales?: string[] | null
          widget_position?: string
          widget_theme?: Json
          workspace_id: string
        }
        Update: {
          allow_visitor_department_choice?: boolean
          allowed_domains?: string[]
          avatar_storage_path?: string | null
          avatar_url?: string | null
          business_hours?: Json
          callback_enabled?: boolean
          created_at?: string
          default_department_id?: string | null
          departments_enabled?: boolean
          display_name?: string | null
          enabled?: boolean
          id?: string
          offline_behavior?: string
          operator_video_visible_to_visitor?: boolean
          pre_call_form_enabled?: boolean
          pre_call_form_schema?: Json
          public_key?: string | null
          recording_consent_required?: boolean
          recording_enabled?: boolean
          routing_mode?: string
          updated_at?: string
          video_enabled?: boolean
          voice_enabled?: boolean
          widget_custom_texts?: Json
          widget_default_locale?: string | null
          widget_enabled_locales?: string[] | null
          widget_position?: string
          widget_theme?: Json
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_center_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      call_events: {
        Row: {
          actor_id: string | null
          actor_type:
            | Database["public"]["Enums"]["call_participant_type"]
            | null
          call_session_id: string
          created_at: string
          event_type: string
          id: string
          payload: Json
        }
        Insert: {
          actor_id?: string | null
          actor_type?:
            | Database["public"]["Enums"]["call_participant_type"]
            | null
          call_session_id: string
          created_at?: string
          event_type: string
          id?: string
          payload?: Json
        }
        Update: {
          actor_id?: string | null
          actor_type?:
            | Database["public"]["Enums"]["call_participant_type"]
            | null
          call_session_id?: string
          created_at?: string
          event_type?: string
          id?: string
          payload?: Json
        }
        Relationships: [
          {
            foreignKeyName: "call_events_call_session_id_fkey"
            columns: ["call_session_id"]
            isOneToOne: false
            referencedRelation: "call_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      call_invitations: {
        Row: {
          call_session_id: string | null
          cancel_reason: string | null
          channel: Database["public"]["Enums"]["call_invitation_channel"]
          contact_id: string | null
          conversation_id: string
          created_at: string
          created_by_user_id: string
          ended_at: string | null
          expires_at: string
          id: string
          joined_at: string | null
          metadata: Json
          status: Database["public"]["Enums"]["call_invitation_status"]
          system_message_id: string | null
          updated_at: string
          visitor_session_id: string | null
          workspace_id: string
        }
        Insert: {
          call_session_id?: string | null
          cancel_reason?: string | null
          channel: Database["public"]["Enums"]["call_invitation_channel"]
          contact_id?: string | null
          conversation_id: string
          created_at?: string
          created_by_user_id: string
          ended_at?: string | null
          expires_at: string
          id?: string
          joined_at?: string | null
          metadata?: Json
          status?: Database["public"]["Enums"]["call_invitation_status"]
          system_message_id?: string | null
          updated_at?: string
          visitor_session_id?: string | null
          workspace_id: string
        }
        Update: {
          call_session_id?: string | null
          cancel_reason?: string | null
          channel?: Database["public"]["Enums"]["call_invitation_channel"]
          contact_id?: string | null
          conversation_id?: string
          created_at?: string
          created_by_user_id?: string
          ended_at?: string | null
          expires_at?: string
          id?: string
          joined_at?: string | null
          metadata?: Json
          status?: Database["public"]["Enums"]["call_invitation_status"]
          system_message_id?: string | null
          updated_at?: string
          visitor_session_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_invitations_call_session_id_fkey"
            columns: ["call_session_id"]
            isOneToOne: false
            referencedRelation: "call_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_invitations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_invitations_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_invitations_system_message_id_fkey"
            columns: ["system_message_id"]
            isOneToOne: false
            referencedRelation: "conversation_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_invitations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      call_participants: {
        Row: {
          call_session_id: string
          created_at: string
          device_info: Json
          id: string
          joined_at: string | null
          left_at: string | null
          media_state: Json
          participant_id: string | null
          participant_type: Database["public"]["Enums"]["call_participant_type"]
          provider_participant_id: string | null
        }
        Insert: {
          call_session_id: string
          created_at?: string
          device_info?: Json
          id?: string
          joined_at?: string | null
          left_at?: string | null
          media_state?: Json
          participant_id?: string | null
          participant_type: Database["public"]["Enums"]["call_participant_type"]
          provider_participant_id?: string | null
        }
        Update: {
          call_session_id?: string
          created_at?: string
          device_info?: Json
          id?: string
          joined_at?: string | null
          left_at?: string | null
          media_state?: Json
          participant_id?: string | null
          participant_type?: Database["public"]["Enums"]["call_participant_type"]
          provider_participant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_participants_call_session_id_fkey"
            columns: ["call_session_id"]
            isOneToOne: false
            referencedRelation: "call_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      call_queue_entries: {
        Row: {
          accepted_at: string | null
          assigned_agent_id: string | null
          call_session_id: string | null
          callback_request_id: string | null
          channel: Database["public"]["Enums"]["call_queue_channel"]
          contact_id: string | null
          conversation_id: string | null
          created_at: string
          department_id: string | null
          ended_at: string | null
          ended_reason: string | null
          entry_source: string
          expires_at: string
          id: string
          last_offer_expires_at: string | null
          last_routing_at: string | null
          metadata: Json
          missed_offer_count: number
          offer_timeout_seconds: number
          offered_at: string | null
          offered_to_user_id: string | null
          position_hint: number | null
          priority: number
          requested_by: string
          routing_attempts: number
          routing_mode: string | null
          sla_breached: boolean
          state: Database["public"]["Enums"]["call_queue_state"]
          updated_at: string
          visitor_session_id: string | null
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          assigned_agent_id?: string | null
          call_session_id?: string | null
          callback_request_id?: string | null
          channel: Database["public"]["Enums"]["call_queue_channel"]
          contact_id?: string | null
          conversation_id?: string | null
          created_at?: string
          department_id?: string | null
          ended_at?: string | null
          ended_reason?: string | null
          entry_source?: string
          expires_at?: string
          id?: string
          last_offer_expires_at?: string | null
          last_routing_at?: string | null
          metadata?: Json
          missed_offer_count?: number
          offer_timeout_seconds?: number
          offered_at?: string | null
          offered_to_user_id?: string | null
          position_hint?: number | null
          priority?: number
          requested_by?: string
          routing_attempts?: number
          routing_mode?: string | null
          sla_breached?: boolean
          state?: Database["public"]["Enums"]["call_queue_state"]
          updated_at?: string
          visitor_session_id?: string | null
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          assigned_agent_id?: string | null
          call_session_id?: string | null
          callback_request_id?: string | null
          channel?: Database["public"]["Enums"]["call_queue_channel"]
          contact_id?: string | null
          conversation_id?: string | null
          created_at?: string
          department_id?: string | null
          ended_at?: string | null
          ended_reason?: string | null
          entry_source?: string
          expires_at?: string
          id?: string
          last_offer_expires_at?: string | null
          last_routing_at?: string | null
          metadata?: Json
          missed_offer_count?: number
          offer_timeout_seconds?: number
          offered_at?: string | null
          offered_to_user_id?: string | null
          position_hint?: number | null
          priority?: number
          requested_by?: string
          routing_attempts?: number
          routing_mode?: string | null
          sla_breached?: boolean
          state?: Database["public"]["Enums"]["call_queue_state"]
          updated_at?: string
          visitor_session_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_queue_entries_call_session_id_fkey"
            columns: ["call_session_id"]
            isOneToOne: false
            referencedRelation: "call_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_queue_entries_callback_request_fk"
            columns: ["callback_request_id"]
            isOneToOne: false
            referencedRelation: "callback_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_queue_entries_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_queue_entries_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_queue_entries_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      call_ratings: {
        Row: {
          call_session_id: string
          comment: string | null
          created_at: string
          id: string
          rating: number
          visitor_id: string | null
          workspace_id: string
        }
        Insert: {
          call_session_id: string
          comment?: string | null
          created_at?: string
          id?: string
          rating: number
          visitor_id?: string | null
          workspace_id: string
        }
        Update: {
          call_session_id?: string
          comment?: string | null
          created_at?: string
          id?: string
          rating?: number
          visitor_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      call_recordings: {
        Row: {
          call_session_id: string
          created_at: string
          duration_seconds: number | null
          id: string
          legal_hold: boolean
          metadata: Json
          provider: string
          provider_recording_id: string | null
          recording_type: string
          retention_expires_at: string | null
          retention_policy: string
          size_bytes: number | null
          storage_path: string
          storage_provider: string
        }
        Insert: {
          call_session_id: string
          created_at?: string
          duration_seconds?: number | null
          id?: string
          legal_hold?: boolean
          metadata?: Json
          provider: string
          provider_recording_id?: string | null
          recording_type?: string
          retention_expires_at?: string | null
          retention_policy?: string
          size_bytes?: number | null
          storage_path: string
          storage_provider: string
        }
        Update: {
          call_session_id?: string
          created_at?: string
          duration_seconds?: number | null
          id?: string
          legal_hold?: boolean
          metadata?: Json
          provider?: string
          provider_recording_id?: string | null
          recording_type?: string
          retention_expires_at?: string | null
          retention_policy?: string
          size_bytes?: number | null
          storage_path?: string
          storage_provider?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_recordings_call_session_id_fkey"
            columns: ["call_session_id"]
            isOneToOne: false
            referencedRelation: "call_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      call_sessions: {
        Row: {
          assigned_agent_id: string | null
          call_type: Database["public"]["Enums"]["call_type"]
          connected_at: string | null
          context_id: string | null
          context_type: Database["public"]["Enums"]["call_context_type"]
          created_at: string
          department_id: string | null
          direction: string
          duration_seconds: number | null
          end_reason: string | null
          ended_at: string | null
          ended_by: string | null
          ended_by_user_id: string | null
          entry_source: string
          id: string
          initiated_by: string | null
          initiated_by_type: Database["public"]["Enums"]["call_participant_type"]
          metadata: Json
          origin: string | null
          page_title: string | null
          page_url: string | null
          provider: string
          provider_room_id: string | null
          recording_enabled: boolean
          recording_state: Database["public"]["Enums"]["call_recording_state"]
          started_at: string | null
          state: Database["public"]["Enums"]["call_state"]
          subject: string | null
          transfer_from_agent_id: string | null
          transfer_reason: string | null
          transfer_to_agent_id: string | null
          transfer_to_department_id: string | null
          updated_at: string
          visitor_email: string | null
          visitor_name: string | null
          visitor_phone: string | null
          visitor_session_id: string | null
          wait_seconds: number
          workspace_id: string
        }
        Insert: {
          assigned_agent_id?: string | null
          call_type: Database["public"]["Enums"]["call_type"]
          connected_at?: string | null
          context_id?: string | null
          context_type: Database["public"]["Enums"]["call_context_type"]
          created_at?: string
          department_id?: string | null
          direction?: string
          duration_seconds?: number | null
          end_reason?: string | null
          ended_at?: string | null
          ended_by?: string | null
          ended_by_user_id?: string | null
          entry_source?: string
          id?: string
          initiated_by?: string | null
          initiated_by_type?: Database["public"]["Enums"]["call_participant_type"]
          metadata?: Json
          origin?: string | null
          page_title?: string | null
          page_url?: string | null
          provider: string
          provider_room_id?: string | null
          recording_enabled?: boolean
          recording_state?: Database["public"]["Enums"]["call_recording_state"]
          started_at?: string | null
          state?: Database["public"]["Enums"]["call_state"]
          subject?: string | null
          transfer_from_agent_id?: string | null
          transfer_reason?: string | null
          transfer_to_agent_id?: string | null
          transfer_to_department_id?: string | null
          updated_at?: string
          visitor_email?: string | null
          visitor_name?: string | null
          visitor_phone?: string | null
          visitor_session_id?: string | null
          wait_seconds?: number
          workspace_id: string
        }
        Update: {
          assigned_agent_id?: string | null
          call_type?: Database["public"]["Enums"]["call_type"]
          connected_at?: string | null
          context_id?: string | null
          context_type?: Database["public"]["Enums"]["call_context_type"]
          created_at?: string
          department_id?: string | null
          direction?: string
          duration_seconds?: number | null
          end_reason?: string | null
          ended_at?: string | null
          ended_by?: string | null
          ended_by_user_id?: string | null
          entry_source?: string
          id?: string
          initiated_by?: string | null
          initiated_by_type?: Database["public"]["Enums"]["call_participant_type"]
          metadata?: Json
          origin?: string | null
          page_title?: string | null
          page_url?: string | null
          provider?: string
          provider_room_id?: string | null
          recording_enabled?: boolean
          recording_state?: Database["public"]["Enums"]["call_recording_state"]
          started_at?: string | null
          state?: Database["public"]["Enums"]["call_state"]
          subject?: string | null
          transfer_from_agent_id?: string | null
          transfer_reason?: string | null
          transfer_to_agent_id?: string | null
          transfer_to_department_id?: string | null
          updated_at?: string
          visitor_email?: string | null
          visitor_name?: string | null
          visitor_phone?: string | null
          visitor_session_id?: string | null
          wait_seconds?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_sessions_visitor_session_id_fkey"
            columns: ["visitor_session_id"]
            isOneToOne: false
            referencedRelation: "visitor_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_sessions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      callback_requests: {
        Row: {
          cancelled_at: string | null
          channel: string
          completed_at: string | null
          contact_email: string | null
          contact_id: string | null
          contact_phone: string | null
          conversation_id: string | null
          created_at: string
          handled_by: string | null
          id: string
          metadata: Json
          notes: string | null
          requested_at: string
          scheduled_at: string | null
          scheduled_for: string | null
          status: string
          updated_at: string
          visitor_session_id: string | null
          workspace_id: string
        }
        Insert: {
          cancelled_at?: string | null
          channel?: string
          completed_at?: string | null
          contact_email?: string | null
          contact_id?: string | null
          contact_phone?: string | null
          conversation_id?: string | null
          created_at?: string
          handled_by?: string | null
          id?: string
          metadata?: Json
          notes?: string | null
          requested_at?: string
          scheduled_at?: string | null
          scheduled_for?: string | null
          status?: string
          updated_at?: string
          visitor_session_id?: string | null
          workspace_id: string
        }
        Update: {
          cancelled_at?: string | null
          channel?: string
          completed_at?: string | null
          contact_email?: string | null
          contact_id?: string | null
          contact_phone?: string | null
          conversation_id?: string | null
          created_at?: string
          handled_by?: string | null
          id?: string
          metadata?: Json
          notes?: string | null
          requested_at?: string
          scheduled_at?: string | null
          scheduled_for?: string | null
          status?: string
          updated_at?: string
          visitor_session_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "callback_requests_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "callback_requests_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "callback_requests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
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
            foreignKeyName: "canned_responses_created_by_profiles_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "canned_responses_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_delivery_attempts: {
        Row: {
          attempt: number
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          job_id: string
          latency_ms: number | null
          status: string
        }
        Insert: {
          attempt: number
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          job_id: string
          latency_ms?: number | null
          status: string
        }
        Update: {
          attempt?: number
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          job_id?: string
          latency_ms?: number | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_delivery_attempts_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "channel_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_inbound_events: {
        Row: {
          contact_id: string | null
          conversation_id: string | null
          created_at: string
          external_event_id: string
          id: string
          integration_id: string
          last_error: string | null
          message_id: string | null
          payload: Json
          processed_at: string | null
          provider: string
          status: string
          workspace_id: string
        }
        Insert: {
          contact_id?: string | null
          conversation_id?: string | null
          created_at?: string
          external_event_id: string
          id?: string
          integration_id: string
          last_error?: string | null
          message_id?: string | null
          payload?: Json
          processed_at?: string | null
          provider: string
          status?: string
          workspace_id: string
        }
        Update: {
          contact_id?: string | null
          conversation_id?: string | null
          created_at?: string
          external_event_id?: string
          id?: string
          integration_id?: string
          last_error?: string | null
          message_id?: string | null
          payload?: Json
          processed_at?: string | null
          provider?: string
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_inbound_events_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "channel_integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_integrations: {
        Row: {
          created_at: string
          display_name: string | null
          external_account_id: string | null
          id: string
          installation_id: string
          last_error_at: string | null
          last_error_code: string | null
          last_inbound_at: string | null
          last_outbound_at: string | null
          metadata: Json
          provider: string
          public_integration_id: string
          status: string
          updated_at: string
          username: string | null
          webhook_registered_at: string | null
          webhook_verified_at: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          external_account_id?: string | null
          id?: string
          installation_id: string
          last_error_at?: string | null
          last_error_code?: string | null
          last_inbound_at?: string | null
          last_outbound_at?: string | null
          metadata?: Json
          provider: string
          public_integration_id: string
          status?: string
          updated_at?: string
          username?: string | null
          webhook_registered_at?: string | null
          webhook_verified_at?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          external_account_id?: string | null
          id?: string
          installation_id?: string
          last_error_at?: string | null
          last_error_code?: string | null
          last_inbound_at?: string | null
          last_outbound_at?: string | null
          metadata?: Json
          provider?: string
          public_integration_id?: string
          status?: string
          updated_at?: string
          username?: string | null
          webhook_registered_at?: string | null
          webhook_verified_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_integrations_installation_id_fkey"
            columns: ["installation_id"]
            isOneToOne: false
            referencedRelation: "workspace_plugin_installations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_integrations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_jobs: {
        Row: {
          attempt_count: number
          available_at: string
          claim_expires_at: string | null
          claim_token: string | null
          created_at: string
          id: string
          integration_id: string | null
          job_type: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          payload: Json
          provider: string
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          attempt_count?: number
          available_at?: string
          claim_expires_at?: string | null
          claim_token?: string | null
          created_at?: string
          id?: string
          integration_id?: string | null
          job_type: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          provider: string
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          attempt_count?: number
          available_at?: string
          claim_expires_at?: string | null
          claim_token?: string | null
          created_at?: string
          id?: string
          integration_id?: string | null
          job_type?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          provider?: string
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_jobs_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "channel_integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_provider_operations: {
        Row: {
          completed_at: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          installation_id: string | null
          integration_id: string | null
          operation: string
          provider: string
          request: Json
          requested_by: string | null
          result: Json | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          installation_id?: string | null
          integration_id?: string | null
          operation: string
          provider: string
          request?: Json
          requested_by?: string | null
          result?: Json | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          installation_id?: string | null
          integration_id?: string | null
          operation?: string
          provider?: string
          request?: Json
          requested_by?: string | null
          result?: Json | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: []
      }
      channel_worker_heartbeats: {
        Row: {
          code_version: string | null
          last_seen_at: string
          metadata: Json
          started_at: string
          worker_id: string
          worker_kind: string
        }
        Insert: {
          code_version?: string | null
          last_seen_at?: string
          metadata?: Json
          started_at?: string
          worker_id: string
          worker_kind: string
        }
        Update: {
          code_version?: string | null
          last_seen_at?: string
          metadata?: Json
          started_at?: string
          worker_id?: string
          worker_kind?: string
        }
        Relationships: []
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
          is_spam: boolean
          metadata: Json | null
          name: string | null
          notes: string | null
          phone: string | null
          spam_marked_at: string | null
          spam_marked_by: string | null
          tags: string[] | null
          updated_at: string | null
          visitor_code: string | null
          workspace_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          is_spam?: boolean
          metadata?: Json | null
          name?: string | null
          notes?: string | null
          phone?: string | null
          spam_marked_at?: string | null
          spam_marked_by?: string | null
          tags?: string[] | null
          updated_at?: string | null
          visitor_code?: string | null
          workspace_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          is_spam?: boolean
          metadata?: Json | null
          name?: string | null
          notes?: string | null
          phone?: string | null
          spam_marked_at?: string | null
          spam_marked_by?: string | null
          tags?: string[] | null
          updated_at?: string | null
          visitor_code?: string | null
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
          ai_state: string | null
          assigned_to: string | null
          contact_id: string | null
          created_at: string | null
          id: string
          is_spam: boolean
          metadata: Json
          priority: Database["public"]["Enums"]["conversation_priority"] | null
          spam_marked_at: string | null
          spam_marked_by: string | null
          status: Database["public"]["Enums"]["conversation_status"] | null
          subject: string | null
          tags: string[] | null
          updated_at: string | null
          visitor_session_id: string | null
          workspace_id: string
        }
        Insert: {
          ai_state?: string | null
          assigned_to?: string | null
          contact_id?: string | null
          created_at?: string | null
          id?: string
          is_spam?: boolean
          metadata?: Json
          priority?: Database["public"]["Enums"]["conversation_priority"] | null
          spam_marked_at?: string | null
          spam_marked_by?: string | null
          status?: Database["public"]["Enums"]["conversation_status"] | null
          subject?: string | null
          tags?: string[] | null
          updated_at?: string | null
          visitor_session_id?: string | null
          workspace_id: string
        }
        Update: {
          ai_state?: string | null
          assigned_to?: string | null
          contact_id?: string | null
          created_at?: string | null
          id?: string
          is_spam?: boolean
          metadata?: Json
          priority?: Database["public"]["Enums"]["conversation_priority"] | null
          spam_marked_at?: string | null
          spam_marked_by?: string | null
          status?: Database["public"]["Enums"]["conversation_status"] | null
          subject?: string | null
          tags?: string[] | null
          updated_at?: string | null
          visitor_session_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_assigned_to_profiles_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
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
      enforcement_actions: {
        Row: {
          auto_action_event_id: string | null
          created_at: string
          dry_run: boolean
          id: string
          rule_id: string
          rule_slug: string
          scope_key: string
          scope_type: string
          trigger_payload: Json
          trigger_type: string
        }
        Insert: {
          auto_action_event_id?: string | null
          created_at?: string
          dry_run?: boolean
          id?: string
          rule_id: string
          rule_slug: string
          scope_key: string
          scope_type: string
          trigger_payload?: Json
          trigger_type: string
        }
        Update: {
          auto_action_event_id?: string | null
          created_at?: string
          dry_run?: boolean
          id?: string
          rule_id?: string
          rule_slug?: string
          scope_key?: string
          scope_type?: string
          trigger_payload?: Json
          trigger_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "enforcement_actions_auto_action_event_id_fkey"
            columns: ["auto_action_event_id"]
            isOneToOne: false
            referencedRelation: "auto_action_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enforcement_actions_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "enforcement_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      enforcement_normalizations: {
        Row: {
          context: Json
          created_at: string
          cycle_ran_at: string
          id: string
          normalized_actions: Json
          raw_actions: Json
          reasons: Json
        }
        Insert: {
          context?: Json
          created_at?: string
          cycle_ran_at?: string
          id?: string
          normalized_actions?: Json
          raw_actions?: Json
          reasons?: Json
        }
        Update: {
          context?: Json
          created_at?: string
          cycle_ran_at?: string
          id?: string
          normalized_actions?: Json
          raw_actions?: Json
          reasons?: Json
        }
        Relationships: []
      }
      enforcement_rules: {
        Row: {
          actions_json: Json
          condition_json: Json
          cooldown_seconds: number
          created_at: string
          description: string | null
          enabled: boolean
          id: string
          is_builtin: boolean
          priority: number
          slug: string
          title: string
          trigger_type: string
          ttl_seconds: number
          updated_at: string
        }
        Insert: {
          actions_json?: Json
          condition_json?: Json
          cooldown_seconds?: number
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          is_builtin?: boolean
          priority?: number
          slug: string
          title: string
          trigger_type: string
          ttl_seconds?: number
          updated_at?: string
        }
        Update: {
          actions_json?: Json
          condition_json?: Json
          cooldown_seconds?: number
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          is_builtin?: boolean
          priority?: number
          slug?: string
          title?: string
          trigger_type?: string
          ttl_seconds?: number
          updated_at?: string
        }
        Relationships: []
      }
      entitlement_fanout_jobs: {
        Row: {
          attempts: number
          claim_expires_at: string | null
          claim_token: string | null
          completed_at: string | null
          created_at: string
          cursor_workspace_id: string | null
          failed_count: number
          id: string
          last_error_code: string | null
          next_attempt_at: string
          plan_id: string | null
          processed_count: number
          scope: string
          source: string
          status: string
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          attempts?: number
          claim_expires_at?: string | null
          claim_token?: string | null
          completed_at?: string | null
          created_at?: string
          cursor_workspace_id?: string | null
          failed_count?: number
          id?: string
          last_error_code?: string | null
          next_attempt_at?: string
          plan_id?: string | null
          processed_count?: number
          scope: string
          source: string
          status?: string
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          attempts?: number
          claim_expires_at?: string | null
          claim_token?: string | null
          completed_at?: string | null
          created_at?: string
          cursor_workspace_id?: string | null
          failed_count?: number
          id?: string
          last_error_code?: string | null
          next_attempt_at?: string
          plan_id?: string | null
          processed_count?: number
          scope?: string
          source?: string
          status?: string
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: []
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
      invitation_secret_material: {
        Row: {
          created_at: string
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          created_at?: string
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          created_at?: string
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
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
      kb_article_feedback: {
        Row: {
          article_id: string
          created_at: string
          id: string
          rating: string
          updated_at: string
          visitor_session_id: string | null
          workspace_id: string
        }
        Insert: {
          article_id: string
          created_at?: string
          id?: string
          rating: string
          updated_at?: string
          visitor_session_id?: string | null
          workspace_id: string
        }
        Update: {
          article_id?: string
          created_at?: string
          id?: string
          rating?: string
          updated_at?: string
          visitor_session_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "kb_article_feedback_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: false
            referencedRelation: "knowledge_base_articles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kb_article_feedback_visitor_session_id_fkey"
            columns: ["visitor_session_id"]
            isOneToOne: false
            referencedRelation: "visitor_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kb_article_feedback_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
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
          used_by_ai: boolean
          visible_in_widget: boolean
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
          used_by_ai?: boolean
          visible_in_widget?: boolean
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
          used_by_ai?: boolean
          visible_in_widget?: boolean
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_base_articles_category_workspace_fkey"
            columns: ["category_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "knowledge_base_categories"
            referencedColumns: ["id", "workspace_id"]
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
      knowledge_base_change_events: {
        Row: {
          article_id: string | null
          attempts: number
          claim_expires_at: string | null
          claim_token: string | null
          claimed_at: string | null
          claimed_by: string | null
          created_at: string
          dead_lettered_at: string | null
          event_type: string
          id: string
          last_error: string | null
          last_error_code: string | null
          last_error_detail: string | null
          locale: string | null
          locked_at: string | null
          locked_by: string | null
          next_attempt_at: string
          processed_at: string | null
          status: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          article_id?: string | null
          attempts?: number
          claim_expires_at?: string | null
          claim_token?: string | null
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string
          dead_lettered_at?: string | null
          event_type: string
          id?: string
          last_error?: string | null
          last_error_code?: string | null
          last_error_detail?: string | null
          locale?: string | null
          locked_at?: string | null
          locked_by?: string | null
          next_attempt_at?: string
          processed_at?: string | null
          status?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          article_id?: string | null
          attempts?: number
          claim_expires_at?: string | null
          claim_token?: string | null
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string
          dead_lettered_at?: string | null
          event_type?: string
          id?: string
          last_error?: string | null
          last_error_code?: string | null
          last_error_detail?: string | null
          locale?: string | null
          locked_at?: string | null
          locked_by?: string | null
          next_attempt_at?: string
          processed_at?: string | null
          status?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: []
      }
      legal_policy_versions: {
        Row: {
          content_hash: string
          document_url: string | null
          effective_from: string
          id: string
          is_active: boolean
          locale: string
          policy_type: string
          published_at: string
          version: string
        }
        Insert: {
          content_hash: string
          document_url?: string | null
          effective_from?: string
          id?: string
          is_active?: boolean
          locale: string
          policy_type: string
          published_at?: string
          version: string
        }
        Update: {
          content_hash?: string
          document_url?: string | null
          effective_from?: string
          id?: string
          is_active?: boolean
          locale?: string
          policy_type?: string
          published_at?: string
          version?: string
        }
        Relationships: []
      }
      livekit_webhook_events: {
        Row: {
          egress_id: string | null
          event_id: string
          event_type: string
          id: string
          participant_identity: string | null
          process_error: string | null
          processed_at: string | null
          raw: Json
          received_at: string
          room_name: string | null
          signature_valid: boolean
        }
        Insert: {
          egress_id?: string | null
          event_id: string
          event_type: string
          id?: string
          participant_identity?: string | null
          process_error?: string | null
          processed_at?: string | null
          raw?: Json
          received_at?: string
          room_name?: string | null
          signature_valid?: boolean
        }
        Update: {
          egress_id?: string | null
          event_id?: string
          event_type?: string
          id?: string
          participant_identity?: string | null
          process_error?: string | null
          processed_at?: string | null
          raw?: Json
          received_at?: string
          room_name?: string | null
          signature_valid?: boolean
        }
        Relationships: []
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
      observability_ticker_lease: {
        Row: {
          acquired_at: string | null
          expires_at: string | null
          last_finished_at: string | null
          name: string
          owner: string | null
          passes: number
        }
        Insert: {
          acquired_at?: string | null
          expires_at?: string | null
          last_finished_at?: string | null
          name: string
          owner?: string | null
          passes?: number
        }
        Update: {
          acquired_at?: string | null
          expires_at?: string | null
          last_finished_at?: string | null
          name?: string
          owner?: string | null
          passes?: number
        }
        Relationships: []
      }
      operator_activity_samples: {
        Row: {
          available: boolean
          bucket: string
          created_at: string
          id: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          available?: boolean
          bucket: string
          created_at?: string
          id?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          available?: boolean
          bucket?: string
          created_at?: string
          id?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      operator_call_availability: {
        Row: {
          active_call_session_id: string | null
          id: string
          in_call: boolean
          in_call_since: string | null
          last_heartbeat_at: string
          status: string
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          active_call_session_id?: string | null
          id?: string
          in_call?: boolean
          in_call_since?: string | null
          last_heartbeat_at?: string
          status?: string
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          active_call_session_id?: string | null
          id?: string
          in_call?: boolean
          in_call_since?: string | null
          last_heartbeat_at?: string
          status?: string
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_call_availability_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
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
      phone_verification_challenges: {
        Row: {
          attempt_count: number
          code_digest: string
          consumed_at: string | null
          created_at: string
          created_by: string
          created_by_admin_id: string | null
          created_ip_hash: string | null
          delivery_status: string
          expires_at: string
          id: string
          invalidated_at: string | null
          is_active: boolean
          max_attempts: number
          phone_e164: string
          provider_message_id: string | null
          provider_name: string | null
          purpose: string
          sent_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          attempt_count?: number
          code_digest: string
          consumed_at?: string | null
          created_at?: string
          created_by?: string
          created_by_admin_id?: string | null
          created_ip_hash?: string | null
          delivery_status?: string
          expires_at: string
          id?: string
          invalidated_at?: string | null
          is_active?: boolean
          max_attempts?: number
          phone_e164: string
          provider_message_id?: string | null
          provider_name?: string | null
          purpose: string
          sent_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          attempt_count?: number
          code_digest?: string
          consumed_at?: string | null
          created_at?: string
          created_by?: string
          created_by_admin_id?: string | null
          created_ip_hash?: string | null
          delivery_status?: string
          expires_at?: string
          id?: string
          invalidated_at?: string | null
          is_active?: boolean
          max_attempts?: number
          phone_e164?: string
          provider_message_id?: string | null
          provider_name?: string | null
          purpose?: string
          sent_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "phone_verification_challenges_user_id_profiles_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
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
      platform_ai_agent_settings: {
        Row: {
          advanced_tools_enabled: boolean
          ai_agent_enabled: boolean
          auto_answer_enabled: boolean
          created_at: string
          customer_ai_agent_visible: boolean
          disabled_message: string | null
          files_enabled: boolean
          id: string
          kb_enabled: boolean
          learning_enabled: boolean
          max_customer_visible_nav_items: number
          metadata: Json
          operator_assist_enabled: boolean
          qna_enabled: boolean
          regression_runner_enabled: boolean
          singleton_key: boolean
          source_health_visible_to_customers: boolean
          test_harness_visible_to_customers: boolean
          updated_at: string
          websites_enabled: boolean
        }
        Insert: {
          advanced_tools_enabled?: boolean
          ai_agent_enabled?: boolean
          auto_answer_enabled?: boolean
          created_at?: string
          customer_ai_agent_visible?: boolean
          disabled_message?: string | null
          files_enabled?: boolean
          id?: string
          kb_enabled?: boolean
          learning_enabled?: boolean
          max_customer_visible_nav_items?: number
          metadata?: Json
          operator_assist_enabled?: boolean
          qna_enabled?: boolean
          regression_runner_enabled?: boolean
          singleton_key?: boolean
          source_health_visible_to_customers?: boolean
          test_harness_visible_to_customers?: boolean
          updated_at?: string
          websites_enabled?: boolean
        }
        Update: {
          advanced_tools_enabled?: boolean
          ai_agent_enabled?: boolean
          auto_answer_enabled?: boolean
          created_at?: string
          customer_ai_agent_visible?: boolean
          disabled_message?: string | null
          files_enabled?: boolean
          id?: string
          kb_enabled?: boolean
          learning_enabled?: boolean
          max_customer_visible_nav_items?: number
          metadata?: Json
          operator_assist_enabled?: boolean
          qna_enabled?: boolean
          regression_runner_enabled?: boolean
          singleton_key?: boolean
          source_health_visible_to_customers?: boolean
          test_harness_visible_to_customers?: boolean
          updated_at?: string
          websites_enabled?: boolean
        }
        Relationships: []
      }
      platform_branding: {
        Row: {
          created_at: string | null
          default_ui_accent: string
          default_ui_chroma: string
          default_ui_font_size: string
          default_ui_skin: string
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
          default_ui_accent?: string
          default_ui_chroma?: string
          default_ui_font_size?: string
          default_ui_skin?: string
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
          default_ui_accent?: string
          default_ui_chroma?: string
          default_ui_font_size?: string
          default_ui_skin?: string
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
      platform_call_center_settings: {
        Row: {
          advanced_routing_enabled: boolean
          call_center_enabled: boolean
          call_recording_enabled: boolean
          call_transfer_enabled: boolean
          callback_honeypot_enabled: boolean
          callback_max_per_ip_per_hour: number
          callback_min_form_seconds: number
          callback_min_message_length: number
          callback_min_seconds_between_requests: number
          callback_requests_enabled: boolean
          callback_require_contact: boolean
          callback_show_when_online: boolean
          created_at: string
          departments_enabled: boolean
          disabled_message: Json
          id: string
          max_callback_requests_per_month: number
          max_concurrent_calls_per_workspace: number
          max_monthly_call_minutes_per_workspace: number
          max_queue_size_per_workspace: number
          max_recording_storage_mb: number
          operator_new_call_sound_enabled: boolean
          queue_eta_seconds_per_position: number
          queue_offer_callback_after_seconds: number
          queue_show_eta: boolean
          queue_show_position: boolean
          ringback_announcement_audio_path: string | null
          ringback_enabled: boolean
          ringback_mode: string
          ringback_music_path: string | null
          ringback_music_url: string | null
          ringback_queue_audio_paths: Json
          screen_share_enabled: boolean
          singleton: boolean
          updated_at: string
          video_calls_enabled: boolean
          voice_calls_enabled: boolean
          widget_available_locales: string[]
          widget_default_locale: string
        }
        Insert: {
          advanced_routing_enabled?: boolean
          call_center_enabled?: boolean
          call_recording_enabled?: boolean
          call_transfer_enabled?: boolean
          callback_honeypot_enabled?: boolean
          callback_max_per_ip_per_hour?: number
          callback_min_form_seconds?: number
          callback_min_message_length?: number
          callback_min_seconds_between_requests?: number
          callback_requests_enabled?: boolean
          callback_require_contact?: boolean
          callback_show_when_online?: boolean
          created_at?: string
          departments_enabled?: boolean
          disabled_message?: Json
          id?: string
          max_callback_requests_per_month?: number
          max_concurrent_calls_per_workspace?: number
          max_monthly_call_minutes_per_workspace?: number
          max_queue_size_per_workspace?: number
          max_recording_storage_mb?: number
          operator_new_call_sound_enabled?: boolean
          queue_eta_seconds_per_position?: number
          queue_offer_callback_after_seconds?: number
          queue_show_eta?: boolean
          queue_show_position?: boolean
          ringback_announcement_audio_path?: string | null
          ringback_enabled?: boolean
          ringback_mode?: string
          ringback_music_path?: string | null
          ringback_music_url?: string | null
          ringback_queue_audio_paths?: Json
          screen_share_enabled?: boolean
          singleton?: boolean
          updated_at?: string
          video_calls_enabled?: boolean
          voice_calls_enabled?: boolean
          widget_available_locales?: string[]
          widget_default_locale?: string
        }
        Update: {
          advanced_routing_enabled?: boolean
          call_center_enabled?: boolean
          call_recording_enabled?: boolean
          call_transfer_enabled?: boolean
          callback_honeypot_enabled?: boolean
          callback_max_per_ip_per_hour?: number
          callback_min_form_seconds?: number
          callback_min_message_length?: number
          callback_min_seconds_between_requests?: number
          callback_requests_enabled?: boolean
          callback_require_contact?: boolean
          callback_show_when_online?: boolean
          created_at?: string
          departments_enabled?: boolean
          disabled_message?: Json
          id?: string
          max_callback_requests_per_month?: number
          max_concurrent_calls_per_workspace?: number
          max_monthly_call_minutes_per_workspace?: number
          max_queue_size_per_workspace?: number
          max_recording_storage_mb?: number
          operator_new_call_sound_enabled?: boolean
          queue_eta_seconds_per_position?: number
          queue_offer_callback_after_seconds?: number
          queue_show_eta?: boolean
          queue_show_position?: boolean
          ringback_announcement_audio_path?: string | null
          ringback_enabled?: boolean
          ringback_mode?: string
          ringback_music_path?: string | null
          ringback_music_url?: string | null
          ringback_queue_audio_paths?: Json
          screen_share_enabled?: boolean
          singleton?: boolean
          updated_at?: string
          video_calls_enabled?: boolean
          voice_calls_enabled?: boolean
          widget_available_locales?: string[]
          widget_default_locale?: string
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
          region_currency: string | null
          region_mode: string
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
          region_currency?: string | null
          region_mode?: string
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
          region_currency?: string | null
          region_mode?: string
          site_mode?: string
          timezone?: string
          updated_at?: string | null
          widget_default_locale?: string
        }
        Relationships: []
      }
      platform_sms_provider_config: {
        Row: {
          config: Json
          created_at: string
          id: string
          is_active: boolean
          provider_name: string
          singleton: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          config?: Json
          created_at?: string
          id?: string
          is_active?: boolean
          provider_name?: string
          singleton?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          config?: Json
          created_at?: string
          id?: string
          is_active?: boolean
          provider_name?: string
          singleton?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      plugin_platform_state: {
        Row: {
          created_at: string
          defaults: Json
          enabled: boolean
          featured: boolean
          installable: boolean
          maintenance_mode: boolean
          marketplace_visible: boolean
          plugin_id: string
          policy: Json
          rollout_status: string
          sort_order: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          defaults?: Json
          enabled?: boolean
          featured?: boolean
          installable?: boolean
          maintenance_mode?: boolean
          marketplace_visible?: boolean
          plugin_id: string
          policy?: Json
          rollout_status?: string
          sort_order?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          defaults?: Json
          enabled?: boolean
          featured?: boolean
          installable?: boolean
          maintenance_mode?: boolean
          marketplace_visible?: boolean
          plugin_id?: string
          policy?: Json
          rollout_status?: string
          sort_order?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      plugin_secrets: {
        Row: {
          algorithm: string
          auth_tag: string
          ciphertext: string
          created_at: string
          fingerprint: string | null
          id: string
          installation_id: string
          key_version: number
          nonce: string
          secret_key: string
          updated_at: string
        }
        Insert: {
          algorithm?: string
          auth_tag: string
          ciphertext: string
          created_at?: string
          fingerprint?: string | null
          id?: string
          installation_id: string
          key_version?: number
          nonce: string
          secret_key: string
          updated_at?: string
        }
        Update: {
          algorithm?: string
          auth_tag?: string
          ciphertext?: string
          created_at?: string
          fingerprint?: string | null
          id?: string
          installation_id?: string
          key_version?: number
          nonce?: string
          secret_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "plugin_secrets_installation_id_fkey"
            columns: ["installation_id"]
            isOneToOne: false
            referencedRelation: "workspace_plugin_installations"
            referencedColumns: ["id"]
          },
        ]
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
          phone: string | null
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
          phone?: string | null
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
          phone?: string | null
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
      realtime_failover_state: {
        Row: {
          candidate_recovery_provider: string | null
          candidate_recovery_since: string | null
          cooldown_until: string | null
          effective_provider: string
          failback_eligible_at: string | null
          id: string
          last_evaluated_at: string | null
          last_failover_at: string | null
          last_failover_reason: string | null
          last_health: Json
          updated_at: string
        }
        Insert: {
          candidate_recovery_provider?: string | null
          candidate_recovery_since?: string | null
          cooldown_until?: string | null
          effective_provider?: string
          failback_eligible_at?: string | null
          id?: string
          last_evaluated_at?: string | null
          last_failover_at?: string | null
          last_failover_reason?: string | null
          last_health?: Json
          updated_at?: string
        }
        Update: {
          candidate_recovery_provider?: string | null
          candidate_recovery_since?: string | null
          cooldown_until?: string | null
          effective_provider?: string
          failback_eligible_at?: string | null
          id?: string
          last_evaluated_at?: string | null
          last_failover_at?: string | null
          last_failover_reason?: string | null
          last_health?: Json
          updated_at?: string
        }
        Relationships: []
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
      role_permissions: {
        Row: {
          created_at: string
          granted: boolean
          id: string
          permission_key: string
          role_slug: string
          updated_at: string
          workspace_id: string | null
        }
        Insert: {
          created_at?: string
          granted?: boolean
          id?: string
          permission_key: string
          role_slug: string
          updated_at?: string
          workspace_id?: string | null
        }
        Update: {
          created_at?: string
          granted?: boolean
          id?: string
          permission_key?: string
          role_slug?: string
          updated_at?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_workspace_id_fkey"
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
      seo_crawls: {
        Row: {
          cancel_requested: boolean
          canonical_url: string
          created_at: string
          created_by: string | null
          error_category: string | null
          error_message: string | null
          finished_at: string | null
          id: string
          job_id: string
          limits: Json
          pages_crawled: number
          pages_discovered: number
          pages_failed: number
          pages_skipped: number
          progress: number
          progress_stage: string | null
          respect_robots: boolean
          robots_summary: Json | null
          score: number | null
          score_breakdown: Json | null
          score_version: string | null
          sitemap_summary: Json | null
          started_at: string | null
          status: string
          updated_at: string
          user_agent: string
          website_id: string
          workspace_id: string
        }
        Insert: {
          cancel_requested?: boolean
          canonical_url: string
          created_at?: string
          created_by?: string | null
          error_category?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          job_id: string
          limits?: Json
          pages_crawled?: number
          pages_discovered?: number
          pages_failed?: number
          pages_skipped?: number
          progress?: number
          progress_stage?: string | null
          respect_robots?: boolean
          robots_summary?: Json | null
          score?: number | null
          score_breakdown?: Json | null
          score_version?: string | null
          sitemap_summary?: Json | null
          started_at?: string | null
          status?: string
          updated_at?: string
          user_agent: string
          website_id: string
          workspace_id: string
        }
        Update: {
          cancel_requested?: boolean
          canonical_url?: string
          created_at?: string
          created_by?: string | null
          error_category?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          job_id?: string
          limits?: Json
          pages_crawled?: number
          pages_discovered?: number
          pages_failed?: number
          pages_skipped?: number
          progress?: number
          progress_stage?: string | null
          respect_robots?: boolean
          robots_summary?: Json | null
          score?: number | null
          score_breakdown?: Json | null
          score_version?: string | null
          sitemap_summary?: Json | null
          started_at?: string | null
          status?: string
          updated_at?: string
          user_agent?: string
          website_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "seo_crawls_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "background_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seo_crawls_website_id_fkey"
            columns: ["website_id"]
            isOneToOne: false
            referencedRelation: "workspace_domains"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seo_crawls_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      seo_issue_pages: {
        Row: {
          created_at: string
          id: string
          issue_id: string
          page_id: string | null
          url: string
        }
        Insert: {
          created_at?: string
          id?: string
          issue_id: string
          page_id?: string | null
          url: string
        }
        Update: {
          created_at?: string
          id?: string
          issue_id?: string
          page_id?: string | null
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "seo_issue_pages_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: false
            referencedRelation: "seo_issues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seo_issue_pages_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "seo_pages"
            referencedColumns: ["id"]
          },
        ]
      }
      seo_issues: {
        Row: {
          affected_count: number
          category: string
          crawl_id: string
          created_at: string
          description: string
          first_detected_at: string
          id: string
          issue_type: string
          last_detected_at: string
          recommendation: string
          severity: string
          status: string
          title: string
          website_id: string
          workspace_id: string
        }
        Insert: {
          affected_count?: number
          category: string
          crawl_id: string
          created_at?: string
          description: string
          first_detected_at?: string
          id?: string
          issue_type: string
          last_detected_at?: string
          recommendation: string
          severity: string
          status?: string
          title: string
          website_id: string
          workspace_id: string
        }
        Update: {
          affected_count?: number
          category?: string
          crawl_id?: string
          created_at?: string
          description?: string
          first_detected_at?: string
          id?: string
          issue_type?: string
          last_detected_at?: string
          recommendation?: string
          severity?: string
          status?: string
          title?: string
          website_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "seo_issues_crawl_id_fkey"
            columns: ["crawl_id"]
            isOneToOne: false
            referencedRelation: "seo_crawls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seo_issues_website_id_fkey"
            columns: ["website_id"]
            isOneToOne: false
            referencedRelation: "workspace_domains"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seo_issues_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      seo_links: {
        Row: {
          anchor_text: string | null
          crawl_id: string
          created_at: string
          http_status: number | null
          id: string
          is_broken: boolean
          is_external: boolean
          rel: string | null
          source_page_id: string
          target_normalized_url: string | null
          target_page_id: string | null
          target_url: string
          workspace_id: string
        }
        Insert: {
          anchor_text?: string | null
          crawl_id: string
          created_at?: string
          http_status?: number | null
          id?: string
          is_broken?: boolean
          is_external?: boolean
          rel?: string | null
          source_page_id: string
          target_normalized_url?: string | null
          target_page_id?: string | null
          target_url: string
          workspace_id: string
        }
        Update: {
          anchor_text?: string | null
          crawl_id?: string
          created_at?: string
          http_status?: number | null
          id?: string
          is_broken?: boolean
          is_external?: boolean
          rel?: string | null
          source_page_id?: string
          target_normalized_url?: string | null
          target_page_id?: string | null
          target_url?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "seo_links_crawl_id_fkey"
            columns: ["crawl_id"]
            isOneToOne: false
            referencedRelation: "seo_crawls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seo_links_source_page_id_fkey"
            columns: ["source_page_id"]
            isOneToOne: false
            referencedRelation: "seo_pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seo_links_target_page_id_fkey"
            columns: ["target_page_id"]
            isOneToOne: false
            referencedRelation: "seo_pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seo_links_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      seo_pages: {
        Row: {
          canonical_status: string | null
          canonical_url: string | null
          charset: string | null
          content_type: string | null
          crawl_id: string
          crawled_at: string | null
          created_at: string
          depth: number
          discovered_via: string
          external_links_count: number
          fetch_error: string | null
          final_url: string | null
          h1: string | null
          h1_count: number
          h2_count: number
          has_mixed_content: boolean
          has_open_graph: boolean
          has_structured_data: boolean
          has_twitter_card: boolean
          html_size_bytes: number | null
          http_status: number | null
          id: string
          images_count: number
          images_missing_alt_count: number
          incoming_internal_links_count: number
          internal_links_count: number
          is_https: boolean
          is_indexable: boolean
          is_nofollow: boolean
          lang: string | null
          meta_description: string | null
          meta_description_length: number | null
          meta_robots: string | null
          normalized_url: string
          redirect_chain: Json
          response_bytes: number | null
          response_time_ms: number | null
          structured_data_errors: Json
          structured_data_types: string[]
          title: string | null
          title_length: number | null
          url: string
          word_count: number
          workspace_id: string
        }
        Insert: {
          canonical_status?: string | null
          canonical_url?: string | null
          charset?: string | null
          content_type?: string | null
          crawl_id: string
          crawled_at?: string | null
          created_at?: string
          depth?: number
          discovered_via?: string
          external_links_count?: number
          fetch_error?: string | null
          final_url?: string | null
          h1?: string | null
          h1_count?: number
          h2_count?: number
          has_mixed_content?: boolean
          has_open_graph?: boolean
          has_structured_data?: boolean
          has_twitter_card?: boolean
          html_size_bytes?: number | null
          http_status?: number | null
          id?: string
          images_count?: number
          images_missing_alt_count?: number
          incoming_internal_links_count?: number
          internal_links_count?: number
          is_https?: boolean
          is_indexable?: boolean
          is_nofollow?: boolean
          lang?: string | null
          meta_description?: string | null
          meta_description_length?: number | null
          meta_robots?: string | null
          normalized_url: string
          redirect_chain?: Json
          response_bytes?: number | null
          response_time_ms?: number | null
          structured_data_errors?: Json
          structured_data_types?: string[]
          title?: string | null
          title_length?: number | null
          url: string
          word_count?: number
          workspace_id: string
        }
        Update: {
          canonical_status?: string | null
          canonical_url?: string | null
          charset?: string | null
          content_type?: string | null
          crawl_id?: string
          crawled_at?: string | null
          created_at?: string
          depth?: number
          discovered_via?: string
          external_links_count?: number
          fetch_error?: string | null
          final_url?: string | null
          h1?: string | null
          h1_count?: number
          h2_count?: number
          has_mixed_content?: boolean
          has_open_graph?: boolean
          has_structured_data?: boolean
          has_twitter_card?: boolean
          html_size_bytes?: number | null
          http_status?: number | null
          id?: string
          images_count?: number
          images_missing_alt_count?: number
          incoming_internal_links_count?: number
          internal_links_count?: number
          is_https?: boolean
          is_indexable?: boolean
          is_nofollow?: boolean
          lang?: string | null
          meta_description?: string | null
          meta_description_length?: number | null
          meta_robots?: string | null
          normalized_url?: string
          redirect_chain?: Json
          response_bytes?: number | null
          response_time_ms?: number | null
          structured_data_errors?: Json
          structured_data_types?: string[]
          title?: string | null
          title_length?: number | null
          url?: string
          word_count?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "seo_pages_crawl_id_fkey"
            columns: ["crawl_id"]
            isOneToOne: false
            referencedRelation: "seo_crawls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seo_pages_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      seo_performance_results: {
        Row: {
          accessibility_score: number | null
          best_practices_score: number | null
          cls: number | null
          crawl_id: string
          created_at: string
          fcp_ms: number | null
          id: string
          inp_ms: number | null
          lcp_ms: number | null
          page_id: string | null
          performance_score: number | null
          raw_summary: Json | null
          seo_score: number | null
          status: string
          tbt_ms: number | null
          url: string
          workspace_id: string
        }
        Insert: {
          accessibility_score?: number | null
          best_practices_score?: number | null
          cls?: number | null
          crawl_id: string
          created_at?: string
          fcp_ms?: number | null
          id?: string
          inp_ms?: number | null
          lcp_ms?: number | null
          page_id?: string | null
          performance_score?: number | null
          raw_summary?: Json | null
          seo_score?: number | null
          status?: string
          tbt_ms?: number | null
          url: string
          workspace_id: string
        }
        Update: {
          accessibility_score?: number | null
          best_practices_score?: number | null
          cls?: number | null
          crawl_id?: string
          created_at?: string
          fcp_ms?: number | null
          id?: string
          inp_ms?: number | null
          lcp_ms?: number | null
          page_id?: string | null
          performance_score?: number | null
          raw_summary?: Json | null
          seo_score?: number | null
          status?: string
          tbt_ms?: number | null
          url?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "seo_performance_results_crawl_id_fkey"
            columns: ["crawl_id"]
            isOneToOne: false
            referencedRelation: "seo_crawls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seo_performance_results_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "seo_pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seo_performance_results_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      seo_sitemaps: {
        Row: {
          crawl_id: string
          created_at: string
          discovered_via: string
          error_message: string | null
          http_status: number | null
          id: string
          status: string
          url: string
          url_count: number
          workspace_id: string
        }
        Insert: {
          crawl_id: string
          created_at?: string
          discovered_via?: string
          error_message?: string | null
          http_status?: number | null
          id?: string
          status: string
          url: string
          url_count?: number
          workspace_id: string
        }
        Update: {
          crawl_id?: string
          created_at?: string
          discovered_via?: string
          error_message?: string | null
          http_status?: number | null
          id?: string
          status?: string
          url?: string
          url_count?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "seo_sitemaps_crawl_id_fkey"
            columns: ["crawl_id"]
            isOneToOne: false
            referencedRelation: "seo_crawls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seo_sitemaps_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      sla_reliability_hourly: {
        Row: {
          bucket_hour: string
          critical_alert_count: number
          degraded_minutes: number
          details: Json
          failover_count: number
          forced_polling_minutes: number
          mean_failover_recovery_seconds: number | null
          realtime_availability_pct: number
          recovery_count: number
          scope_key: string
          scope_type: string
          unhealthy_minutes: number
          uptime_pct: number
          warn_alert_count: number
        }
        Insert: {
          bucket_hour: string
          critical_alert_count?: number
          degraded_minutes?: number
          details?: Json
          failover_count?: number
          forced_polling_minutes?: number
          mean_failover_recovery_seconds?: number | null
          realtime_availability_pct?: number
          recovery_count?: number
          scope_key: string
          scope_type: string
          unhealthy_minutes?: number
          uptime_pct?: number
          warn_alert_count?: number
        }
        Update: {
          bucket_hour?: string
          critical_alert_count?: number
          degraded_minutes?: number
          details?: Json
          failover_count?: number
          forced_polling_minutes?: number
          mean_failover_recovery_seconds?: number | null
          realtime_availability_pct?: number
          recovery_count?: number
          scope_key?: string
          scope_type?: string
          unhealthy_minutes?: number
          uptime_pct?: number
          warn_alert_count?: number
        }
        Relationships: []
      }
      slo_breach_events: {
        Row: {
          consecutive_breaches: number
          details: Json
          first_breach_at: string
          id: string
          last_breach_at: string
          observed_value: number | null
          resolved_at: string | null
          scope_key: string
          scope_type: string
          slo_id: string
          slo_slug: string
          state: string
          target_type: string
          target_value: number
        }
        Insert: {
          consecutive_breaches?: number
          details?: Json
          first_breach_at?: string
          id?: string
          last_breach_at?: string
          observed_value?: number | null
          resolved_at?: string | null
          scope_key: string
          scope_type: string
          slo_id: string
          slo_slug: string
          state: string
          target_type: string
          target_value: number
        }
        Update: {
          consecutive_breaches?: number
          details?: Json
          first_breach_at?: string
          id?: string
          last_breach_at?: string
          observed_value?: number | null
          resolved_at?: string | null
          scope_key?: string
          scope_type?: string
          slo_id?: string
          slo_slug?: string
          state?: string
          target_type?: string
          target_value?: number
        }
        Relationships: [
          {
            foreignKeyName: "slo_breach_events_slo_id_fkey"
            columns: ["slo_id"]
            isOneToOne: false
            referencedRelation: "slo_definitions"
            referencedColumns: ["id"]
          },
        ]
      }
      slo_definitions: {
        Row: {
          created_at: string
          description: string | null
          enabled: boolean
          id: string
          is_builtin: boolean
          metric_key: string
          scope_type: string
          slug: string
          target_type: string
          target_value: number
          title: string
          updated_at: string
          window_seconds: number
        }
        Insert: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          is_builtin?: boolean
          metric_key: string
          scope_type: string
          slug: string
          target_type: string
          target_value: number
          title: string
          updated_at?: string
          window_seconds?: number
        }
        Update: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          is_builtin?: boolean
          metric_key?: string
          scope_type?: string
          slug?: string
          target_type?: string
          target_value?: number
          title?: string
          updated_at?: string
          window_seconds?: number
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
      team_messages: {
        Row: {
          attachment_id: string | null
          body: string
          created_at: string
          id: string
          read_at: string | null
          recipient_id: string
          sender_id: string
          workspace_id: string
        }
        Insert: {
          attachment_id?: string | null
          body?: string
          created_at?: string
          id?: string
          read_at?: string | null
          recipient_id: string
          sender_id: string
          workspace_id: string
        }
        Update: {
          attachment_id?: string | null
          body?: string
          created_at?: string
          id?: string
          read_at?: string | null
          recipient_id?: string
          sender_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_messages_attachment_id_fkey"
            columns: ["attachment_id"]
            isOneToOne: false
            referencedRelation: "conversation_attachments"
            referencedColumns: ["id"]
          },
        ]
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
            foreignKeyName: "user_availability_prefs_user_id_profiles_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
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
      user_credentials: {
        Row: {
          created_at: string
          email_verified_at: string | null
          failed_login_count: number
          last_login_at: string | null
          password_algo: string
          password_hash: string | null
          password_set_at: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email_verified_at?: string | null
          failed_login_count?: number
          last_login_at?: string | null
          password_algo?: string
          password_hash?: string | null
          password_set_at?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email_verified_at?: string | null
          failed_login_count?: number
          last_login_at?: string | null
          password_algo?: string
          password_hash?: string | null
          password_set_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_credentials_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
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
            foreignKeyName: "user_notification_prefs_user_id_profiles_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_notification_prefs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      user_phone_verifications: {
        Row: {
          country_code: string
          created_at: string
          last_verified_at: string | null
          manual_verification_reason: string | null
          phone_e164: string
          phone_verified_at: string | null
          updated_at: string
          user_id: string
          verification_method: string | null
          verified_by_admin_id: string | null
        }
        Insert: {
          country_code?: string
          created_at?: string
          last_verified_at?: string | null
          manual_verification_reason?: string | null
          phone_e164: string
          phone_verified_at?: string | null
          updated_at?: string
          user_id: string
          verification_method?: string | null
          verified_by_admin_id?: string | null
        }
        Update: {
          country_code?: string
          created_at?: string
          last_verified_at?: string | null
          manual_verification_reason?: string | null
          phone_e164?: string
          phone_verified_at?: string | null
          updated_at?: string
          user_id?: string
          verification_method?: string | null
          verified_by_admin_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_phone_verifications_user_id_profiles_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
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
        Relationships: [
          {
            foreignKeyName: "user_roles_user_id_profiles_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      verification_admin_idempotency: {
        Row: {
          created_at: string
          expires_at: string
          purpose: string
          request_fingerprint: string
          request_id: string
          result: Json
        }
        Insert: {
          created_at?: string
          expires_at?: string
          purpose: string
          request_fingerprint: string
          request_id: string
          result: Json
        }
        Update: {
          created_at?: string
          expires_at?: string
          purpose?: string
          request_fingerprint?: string
          request_id?: string
          result?: Json
        }
        Relationships: []
      }
      verification_attempts: {
        Row: {
          attempt_no: number
          challenge_id: string
          created_at: string
          id: string
          ip_hash: string | null
          result: string
        }
        Insert: {
          attempt_no: number
          challenge_id: string
          created_at?: string
          id?: string
          ip_hash?: string | null
          result: string
        }
        Update: {
          attempt_no?: number
          challenge_id?: string
          created_at?: string
          id?: string
          ip_hash?: string | null
          result?: string
        }
        Relationships: [
          {
            foreignKeyName: "verification_attempts_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: false
            referencedRelation: "verification_challenges"
            referencedColumns: ["id"]
          },
        ]
      }
      verification_challenges: {
        Row: {
          attempt_count: number
          channel: string
          code_digest: string
          created_at: string
          created_by_context: string
          destination_hash: string
          destination_normalized: string
          expires_at: string
          generation: number
          handle: string
          id: string
          idempotency_key: string | null
          key_version: number
          locale: string
          max_attempts: number
          max_sends: number
          purpose: string
          request_ip_hash: string | null
          resend_cooldown_seconds: number
          revoked_at: string | null
          revoked_reason: string | null
          send_count: number
          status: string
          subject_kind: string
          subject_ref: string | null
          subject_ref_hash: string | null
          verified_at: string | null
          workspace_id: string | null
        }
        Insert: {
          attempt_count?: number
          channel: string
          code_digest: string
          created_at?: string
          created_by_context?: string
          destination_hash: string
          destination_normalized: string
          expires_at: string
          generation?: number
          handle: string
          id?: string
          idempotency_key?: string | null
          key_version: number
          locale: string
          max_attempts: number
          max_sends: number
          purpose: string
          request_ip_hash?: string | null
          resend_cooldown_seconds: number
          revoked_at?: string | null
          revoked_reason?: string | null
          send_count?: number
          status?: string
          subject_kind: string
          subject_ref?: string | null
          subject_ref_hash?: string | null
          verified_at?: string | null
          workspace_id?: string | null
        }
        Update: {
          attempt_count?: number
          channel?: string
          code_digest?: string
          created_at?: string
          created_by_context?: string
          destination_hash?: string
          destination_normalized?: string
          expires_at?: string
          generation?: number
          handle?: string
          id?: string
          idempotency_key?: string | null
          key_version?: number
          locale?: string
          max_attempts?: number
          max_sends?: number
          purpose?: string
          request_ip_hash?: string | null
          resend_cooldown_seconds?: number
          revoked_at?: string | null
          revoked_reason?: string | null
          send_count?: number
          status?: string
          subject_kind?: string
          subject_ref?: string | null
          subject_ref_hash?: string | null
          verified_at?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "verification_challenges_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      verification_delivery_attempts: {
        Row: {
          challenge_id: string
          channel: string
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          idempotency_key: string
          outcome: string
          provider_message_id: string | null
          provider_name: string | null
        }
        Insert: {
          challenge_id: string
          channel: string
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          idempotency_key: string
          outcome: string
          provider_message_id?: string | null
          provider_name?: string | null
        }
        Update: {
          challenge_id?: string
          channel?: string
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          idempotency_key?: string
          outcome?: string
          provider_message_id?: string | null
          provider_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "verification_delivery_attempts_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: false
            referencedRelation: "verification_challenges"
            referencedColumns: ["id"]
          },
        ]
      }
      verification_idempotency: {
        Row: {
          actor_ref_hash: string | null
          attempt_token: string | null
          challenge_id: string | null
          completed_at: string | null
          created_at: string
          expires_at: string
          key: string
          operation: string
          prepared_at: string | null
          purpose: string | null
          request_fingerprint: string
          result_state: string
          safe_result: Json | null
          scope_kind: string
          workspace_id: string | null
        }
        Insert: {
          actor_ref_hash?: string | null
          attempt_token?: string | null
          challenge_id?: string | null
          completed_at?: string | null
          created_at?: string
          expires_at?: string
          key: string
          operation: string
          prepared_at?: string | null
          purpose?: string | null
          request_fingerprint: string
          result_state?: string
          safe_result?: Json | null
          scope_kind: string
          workspace_id?: string | null
        }
        Update: {
          actor_ref_hash?: string | null
          attempt_token?: string | null
          challenge_id?: string | null
          completed_at?: string | null
          created_at?: string
          expires_at?: string
          key?: string
          operation?: string
          prepared_at?: string | null
          purpose?: string | null
          request_fingerprint?: string
          result_state?: string
          safe_result?: Json | null
          scope_kind?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      verification_proofs: {
        Row: {
          challenge_id: string
          channel: string
          consumed_at: string | null
          consumed_by_context: string | null
          created_at: string
          destination_hash: string
          destination_hash_key_version: number
          destination_normalized: string
          expires_at: string
          id: string
          proof_hash: string
          proof_key_version: number
          purpose: string
          revoked_at: string | null
          status: string
          subject_kind: string
          subject_ref: string | null
          subject_ref_hash: string | null
          workspace_id: string | null
        }
        Insert: {
          challenge_id: string
          channel: string
          consumed_at?: string | null
          consumed_by_context?: string | null
          created_at?: string
          destination_hash: string
          destination_hash_key_version: number
          destination_normalized: string
          expires_at: string
          id?: string
          proof_hash: string
          proof_key_version: number
          purpose: string
          revoked_at?: string | null
          status?: string
          subject_kind: string
          subject_ref?: string | null
          subject_ref_hash?: string | null
          workspace_id?: string | null
        }
        Update: {
          challenge_id?: string
          channel?: string
          consumed_at?: string | null
          consumed_by_context?: string | null
          created_at?: string
          destination_hash?: string
          destination_hash_key_version?: number
          destination_normalized?: string
          expires_at?: string
          id?: string
          proof_hash?: string
          proof_key_version?: number
          purpose?: string
          revoked_at?: string | null
          status?: string
          subject_kind?: string
          subject_ref?: string | null
          subject_ref_hash?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "verification_proofs_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: true
            referencedRelation: "verification_challenges"
            referencedColumns: ["id"]
          },
        ]
      }
      verification_purpose_settings: {
        Row: {
          admin_enabled: boolean
          created_at: string
          default_locale: string
          global_rate_limit_enabled: boolean
          global_rate_limit_max_per_window: number | null
          global_rate_limit_window_seconds: number | null
          max_sends_per_window: number
          max_verification_attempts: number
          otp_length: number
          otp_ttl_seconds: number
          proof_ttl_seconds: number
          purpose: string
          rate_window_seconds: number
          resend_cooldown_seconds: number
          revision: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          admin_enabled?: boolean
          created_at?: string
          default_locale?: string
          global_rate_limit_enabled?: boolean
          global_rate_limit_max_per_window?: number | null
          global_rate_limit_window_seconds?: number | null
          max_sends_per_window: number
          max_verification_attempts: number
          otp_length: number
          otp_ttl_seconds: number
          proof_ttl_seconds: number
          purpose: string
          rate_window_seconds: number
          resend_cooldown_seconds: number
          revision?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          admin_enabled?: boolean
          created_at?: string
          default_locale?: string
          global_rate_limit_enabled?: boolean
          global_rate_limit_max_per_window?: number | null
          global_rate_limit_window_seconds?: number | null
          max_sends_per_window?: number
          max_verification_attempts?: number
          otp_length?: number
          otp_ttl_seconds?: number
          proof_ttl_seconds?: number
          purpose?: string
          rate_window_seconds?: number
          resend_cooldown_seconds?: number
          revision?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "verification_purpose_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      verification_purpose_settings_audit: {
        Row: {
          action: string
          actor_profile_id: string | null
          created_at: string
          id: string
          ip_hash: string | null
          locale: string | null
          new_settings: Json
          previous_settings: Json
          purpose: string
          request_id: string
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_profile_id?: string | null
          created_at?: string
          id?: string
          ip_hash?: string | null
          locale?: string | null
          new_settings: Json
          previous_settings: Json
          purpose: string
          request_id: string
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_profile_id?: string | null
          created_at?: string
          id?: string
          ip_hash?: string | null
          locale?: string | null
          new_settings?: Json
          previous_settings?: Json
          purpose?: string
          request_id?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "verification_purpose_settings_audit_actor_profile_id_fkey"
            columns: ["actor_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
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
      widget_conversation_reads: {
        Row: {
          conversation_id: string
          created_at: string
          id: string
          last_read_at: string
          updated_at: string
          visitor_id: string
          workspace_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          id?: string
          last_read_at?: string
          updated_at?: string
          visitor_id: string
          workspace_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          id?: string
          last_read_at?: string
          updated_at?: string
          visitor_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "widget_conversation_reads_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "widget_conversation_reads_workspace_id_fkey"
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
          powered_by_brand_text: string | null
          powered_by_enabled: boolean
          powered_by_text: string
          powered_by_url: string | null
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
          powered_by_brand_text?: string | null
          powered_by_enabled?: boolean
          powered_by_text?: string
          powered_by_url?: string | null
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
          powered_by_brand_text?: string | null
          powered_by_enabled?: boolean
          powered_by_text?: string
          powered_by_url?: string | null
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
          prechat_timing: string
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
          prechat_timing?: string
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
          prechat_timing?: string
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
          assignment_mode: string
          attachments_allowed_mimes: string[]
          attachments_enabled: boolean
          attachments_max_size_mb: number
          auto_open_delay: number | null
          availability_labels: Json
          brand_name: string | null
          business_hours: Json
          chat_enabled: boolean | null
          created_at: string | null
          debug_mode: boolean
          default_mode: string | null
          emoji_enabled: boolean
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
          reply_time_text: string | null
          round_robin_cursor_user_id: string | null
          secondary_color: string | null
          shadow_color: string | null
          show_logo: boolean | null
          show_team_avatars: boolean
          smart_engagement_enabled: boolean
          store_raw_ip: boolean
          support_mode: string | null
          theme: string | null
          updated_at: string | null
          visitor_tracking_enabled: boolean | null
          voice_notes_enabled: boolean
          welcome_message: string | null
          widget_language: string | null
          workspace_id: string
        }
        Insert: {
          allow_subdomains?: boolean
          allowed_domains?: string[] | null
          assignment_mode?: string
          attachments_allowed_mimes?: string[]
          attachments_enabled?: boolean
          attachments_max_size_mb?: number
          auto_open_delay?: number | null
          availability_labels?: Json
          brand_name?: string | null
          business_hours?: Json
          chat_enabled?: boolean | null
          created_at?: string | null
          debug_mode?: boolean
          default_mode?: string | null
          emoji_enabled?: boolean
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
          reply_time_text?: string | null
          round_robin_cursor_user_id?: string | null
          secondary_color?: string | null
          shadow_color?: string | null
          show_logo?: boolean | null
          show_team_avatars?: boolean
          smart_engagement_enabled?: boolean
          store_raw_ip?: boolean
          support_mode?: string | null
          theme?: string | null
          updated_at?: string | null
          visitor_tracking_enabled?: boolean | null
          voice_notes_enabled?: boolean
          welcome_message?: string | null
          widget_language?: string | null
          workspace_id: string
        }
        Update: {
          allow_subdomains?: boolean
          allowed_domains?: string[] | null
          assignment_mode?: string
          attachments_allowed_mimes?: string[]
          attachments_enabled?: boolean
          attachments_max_size_mb?: number
          auto_open_delay?: number | null
          availability_labels?: Json
          brand_name?: string | null
          business_hours?: Json
          chat_enabled?: boolean | null
          created_at?: string | null
          debug_mode?: boolean
          default_mode?: string | null
          emoji_enabled?: boolean
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
          reply_time_text?: string | null
          round_robin_cursor_user_id?: string | null
          secondary_color?: string | null
          shadow_color?: string | null
          show_logo?: boolean | null
          show_team_avatars?: boolean
          smart_engagement_enabled?: boolean
          store_raw_ip?: boolean
          support_mode?: string | null
          theme?: string | null
          updated_at?: string | null
          visitor_tracking_enabled?: boolean | null
          voice_notes_enabled?: boolean
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
      widget_smart_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          idempotency_key: string
          page_path: string | null
          rule_id: string
          rule_version: number
          session_id: string | null
          visitor_id: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          idempotency_key: string
          page_path?: string | null
          rule_id: string
          rule_version?: number
          session_id?: string | null
          visitor_id?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          idempotency_key?: string
          page_path?: string | null
          rule_id?: string
          rule_version?: number
          session_id?: string | null
          visitor_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "widget_smart_events_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "widget_smart_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "widget_smart_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "widget_smart_events_workspace_rule_fkey"
            columns: ["workspace_id", "rule_id"]
            isOneToOne: false
            referencedRelation: "widget_smart_rules"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      widget_smart_rules: {
        Row: {
          audience_config: Json
          behavior_config: Json
          content_config: Json
          created_at: string
          created_by: string | null
          description: string | null
          frequency_config: Json
          id: string
          name: string
          presentation_config: Json
          priority: number
          published_at: string | null
          published_audience_config: Json | null
          published_behavior_config: Json | null
          published_content_config: Json | null
          published_frequency_config: Json | null
          published_presentation_config: Json | null
          published_priority: number | null
          published_schedule_config: Json | null
          published_schema_version: number | null
          published_trigger_config: Json | null
          published_version: number
          schedule_config: Json
          schema_version: number
          status: string
          trigger_config: Json
          updated_at: string
          updated_by: string | null
          workspace_id: string
        }
        Insert: {
          audience_config?: Json
          behavior_config?: Json
          content_config?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          frequency_config?: Json
          id?: string
          name: string
          presentation_config?: Json
          priority?: number
          published_at?: string | null
          published_audience_config?: Json | null
          published_behavior_config?: Json | null
          published_content_config?: Json | null
          published_frequency_config?: Json | null
          published_presentation_config?: Json | null
          published_priority?: number | null
          published_schedule_config?: Json | null
          published_schema_version?: number | null
          published_trigger_config?: Json | null
          published_version?: number
          schedule_config?: Json
          schema_version?: number
          status?: string
          trigger_config?: Json
          updated_at?: string
          updated_by?: string | null
          workspace_id: string
        }
        Update: {
          audience_config?: Json
          behavior_config?: Json
          content_config?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          frequency_config?: Json
          id?: string
          name?: string
          presentation_config?: Json
          priority?: number
          published_at?: string | null
          published_audience_config?: Json | null
          published_behavior_config?: Json | null
          published_content_config?: Json | null
          published_frequency_config?: Json | null
          published_presentation_config?: Json | null
          published_priority?: number | null
          published_schedule_config?: Json | null
          published_schema_version?: number | null
          published_trigger_config?: Json | null
          published_version?: number
          schedule_config?: Json
          schema_version?: number
          status?: string
          trigger_config?: Json
          updated_at?: string
          updated_by?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "widget_smart_rules_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_ai_balance_alerts: {
        Row: {
          billing_cycle_id: string
          created_at: string
          id: string
          threshold: number
          workspace_id: string
        }
        Insert: {
          billing_cycle_id: string
          created_at?: string
          id?: string
          threshold: number
          workspace_id: string
        }
        Update: {
          billing_cycle_id?: string
          created_at?: string
          id?: string
          threshold?: number
          workspace_id?: string
        }
        Relationships: []
      }
      workspace_ai_balance_lots: {
        Row: {
          allowance_source: string | null
          billing_cycle_id: string | null
          created_at: string
          expires_at: string | null
          id: string
          original_amount: number
          remaining_amount: number
          reserved_amount: number
          source_type: string
          state: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          allowance_source?: string | null
          billing_cycle_id?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          original_amount?: number
          remaining_amount?: number
          reserved_amount?: number
          source_type: string
          state?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          allowance_source?: string | null
          billing_cycle_id?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          original_amount?: number
          remaining_amount?: number
          reserved_amount?: number
          source_type?: string
          state?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: []
      }
      workspace_ai_ledger: {
        Row: {
          amount: number
          billing_cycle_id: string | null
          command_id: string | null
          created_at: string
          entry_type: string
          id: string
          reason: string | null
          run_id: string | null
          workspace_id: string
        }
        Insert: {
          amount: number
          billing_cycle_id?: string | null
          command_id?: string | null
          created_at?: string
          entry_type: string
          id?: string
          reason?: string | null
          run_id?: string | null
          workspace_id: string
        }
        Update: {
          amount?: number
          billing_cycle_id?: string | null
          command_id?: string | null
          created_at?: string
          entry_type?: string
          id?: string
          reason?: string | null
          run_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      workspace_ai_ledger_allocations: {
        Row: {
          amount: number
          created_at: string
          id: string
          ledger_entry_id: string
          lot_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          ledger_entry_id: string
          lot_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          ledger_entry_id?: string
          lot_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_ai_ledger_allocations_ledger_entry_id_fkey"
            columns: ["ledger_entry_id"]
            isOneToOne: false
            referencedRelation: "workspace_ai_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_ai_ledger_allocations_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "workspace_ai_balance_lots"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_ai_reservation_allocations: {
        Row: {
          amount: number
          created_at: string
          id: string
          lot_id: string
          reservation_id: string
        }
        Insert: {
          amount?: number
          created_at?: string
          id?: string
          lot_id: string
          reservation_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          lot_id?: string
          reservation_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_ai_reservation_allocations_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "workspace_ai_balance_lots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_ai_reservation_allocations_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "workspace_ai_reservations"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_ai_reservations: {
        Row: {
          amount: number
          created_at: string
          expires_at: string
          id: string
          run_id: string | null
          state: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          amount?: number
          created_at?: string
          expires_at?: string
          id?: string
          run_id?: string | null
          state?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          expires_at?: string
          id?: string
          run_id?: string | null
          state?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_ai_reservations_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "ai_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_ai_wallets: {
        Row: {
          available_amount: number
          created_at: string
          currency: string
          lifetime_charged: number
          reserved_amount: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          available_amount?: number
          created_at?: string
          currency?: string
          lifetime_charged?: number
          reserved_amount?: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          available_amount?: number
          created_at?: string
          currency?: string
          lifetime_charged?: number
          reserved_amount?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: []
      }
      workspace_alert_dismissals: {
        Row: {
          alert_key: string
          dismissed_at: string
          dismissed_until: string | null
          id: string
          signature: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          alert_key: string
          dismissed_at?: string
          dismissed_until?: string | null
          id?: string
          signature?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          alert_key?: string
          dismissed_at?: string
          dismissed_until?: string | null
          id?: string
          signature?: string
          user_id?: string
          workspace_id?: string
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
      workspace_department_members: {
        Row: {
          call_center_enabled: boolean
          call_center_max_concurrent_calls: number | null
          call_center_metadata: Json
          call_center_priority: number
          call_center_role: string
          created_at: string
          department_id: string
          id: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          call_center_enabled?: boolean
          call_center_max_concurrent_calls?: number | null
          call_center_metadata?: Json
          call_center_priority?: number
          call_center_role?: string
          created_at?: string
          department_id: string
          id?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          call_center_enabled?: boolean
          call_center_max_concurrent_calls?: number | null
          call_center_metadata?: Json
          call_center_priority?: number
          call_center_role?: string
          created_at?: string
          department_id?: string
          id?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_department_members_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "workspace_departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_department_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_departments: {
        Row: {
          audio_enabled: boolean
          cc_callback_enabled: boolean
          cc_fallback_department_id: string | null
          cc_routing_mode: string | null
          cc_routing_state: Json
          cc_video_enabled: boolean
          cc_voice_enabled: boolean
          chat_enabled: boolean
          created_at: string
          enabled: boolean
          id: string
          name: string
          sort_order: number
          tickets_enabled: boolean
          updated_at: string
          video_enabled: boolean
          workspace_id: string
        }
        Insert: {
          audio_enabled?: boolean
          cc_callback_enabled?: boolean
          cc_fallback_department_id?: string | null
          cc_routing_mode?: string | null
          cc_routing_state?: Json
          cc_video_enabled?: boolean
          cc_voice_enabled?: boolean
          chat_enabled?: boolean
          created_at?: string
          enabled?: boolean
          id?: string
          name: string
          sort_order?: number
          tickets_enabled?: boolean
          updated_at?: string
          video_enabled?: boolean
          workspace_id: string
        }
        Update: {
          audio_enabled?: boolean
          cc_callback_enabled?: boolean
          cc_fallback_department_id?: string | null
          cc_routing_mode?: string | null
          cc_routing_state?: Json
          cc_video_enabled?: boolean
          cc_voice_enabled?: boolean
          chat_enabled?: boolean
          created_at?: string
          enabled?: boolean
          id?: string
          name?: string
          sort_order?: number
          tickets_enabled?: boolean
          updated_at?: string
          video_enabled?: boolean
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_departments_cc_fallback_department_id_fkey"
            columns: ["cc_fallback_department_id"]
            isOneToOne: false
            referencedRelation: "workspace_departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_departments_workspace_id_fkey"
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
      workspace_health_snapshots: {
        Row: {
          captured_at: string
          components: Json
          health_score: number
          id: string
          inputs: Json
          state: string
          workspace_id: string
        }
        Insert: {
          captured_at?: string
          components?: Json
          health_score: number
          id?: string
          inputs?: Json
          state: string
          workspace_id: string
        }
        Update: {
          captured_at?: string
          components?: Json
          health_score?: number
          id?: string
          inputs?: Json
          state?: string
          workspace_id?: string
        }
        Relationships: []
      }
      workspace_invitation_consents: {
        Row: {
          acceptance_method: string
          accepted_at: string
          id: string
          invitation_id: string
          ip: string | null
          locale: string | null
          privacy_content_hash: string
          privacy_version_id: string
          terms_content_hash: string
          terms_version_id: string
          user_agent: string | null
          user_id: string
          workspace_id: string
        }
        Insert: {
          acceptance_method: string
          accepted_at?: string
          id?: string
          invitation_id: string
          ip?: string | null
          locale?: string | null
          privacy_content_hash: string
          privacy_version_id: string
          terms_content_hash: string
          terms_version_id: string
          user_agent?: string | null
          user_id: string
          workspace_id: string
        }
        Update: {
          acceptance_method?: string
          accepted_at?: string
          id?: string
          invitation_id?: string
          ip?: string | null
          locale?: string | null
          privacy_content_hash?: string
          privacy_version_id?: string
          terms_content_hash?: string
          terms_version_id?: string
          user_agent?: string | null
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invitation_consents_invitation_id_fkey"
            columns: ["invitation_id"]
            isOneToOne: true
            referencedRelation: "workspace_invitations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invitation_consents_privacy_version_id_fkey"
            columns: ["privacy_version_id"]
            isOneToOne: false
            referencedRelation: "legal_policy_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invitation_consents_terms_version_id_fkey"
            columns: ["terms_version_id"]
            isOneToOne: false
            referencedRelation: "legal_policy_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invitation_consents_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invitation_consents_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_invitation_contexts: {
        Row: {
          consumed_at: string | null
          created_at: string
          expires_at: string
          handle_hash: string
          id: string
          invitation_id: string
          notification_generation: number
          purpose: string
          revoked_at: string | null
          token_generation: number
          token_id: string
          workspace_id: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          handle_hash: string
          id?: string
          invitation_id: string
          notification_generation: number
          purpose: string
          revoked_at?: string | null
          token_generation: number
          token_id: string
          workspace_id: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          handle_hash?: string
          id?: string
          invitation_id?: string
          notification_generation?: number
          purpose?: string
          revoked_at?: string | null
          token_generation?: number
          token_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invitation_contexts_invitation_fk"
            columns: ["invitation_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "workspace_invitations"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "workspace_invitation_contexts_token_id_fkey"
            columns: ["token_id"]
            isOneToOne: false
            referencedRelation: "workspace_invitation_tokens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invitation_contexts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_invitation_deliveries: {
        Row: {
          attempt_number: number
          channel: string
          created_at: string
          delivered_at: string | null
          error_code: string | null
          failed_at: string | null
          id: string
          invitation_id: string
          job_id: string | null
          metadata: Json
          notification_generation: number
          provider_accepted_at: string | null
          provider_message_id: string | null
          provider_name: string | null
          safe_error_message: string | null
          sent_at: string | null
          status: string
          workspace_id: string
        }
        Insert: {
          attempt_number?: number
          channel: string
          created_at?: string
          delivered_at?: string | null
          error_code?: string | null
          failed_at?: string | null
          id?: string
          invitation_id: string
          job_id?: string | null
          metadata?: Json
          notification_generation: number
          provider_accepted_at?: string | null
          provider_message_id?: string | null
          provider_name?: string | null
          safe_error_message?: string | null
          sent_at?: string | null
          status: string
          workspace_id: string
        }
        Update: {
          attempt_number?: number
          channel?: string
          created_at?: string
          delivered_at?: string | null
          error_code?: string | null
          failed_at?: string | null
          id?: string
          invitation_id?: string
          job_id?: string | null
          metadata?: Json
          notification_generation?: number
          provider_accepted_at?: string | null
          provider_message_id?: string | null
          provider_name?: string | null
          safe_error_message?: string | null
          sent_at?: string | null
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invitation_deliveries_invitation_fk"
            columns: ["invitation_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "workspace_invitations"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "workspace_invitation_deliveries_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "workspace_invitation_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_invitation_departments: {
        Row: {
          created_at: string
          department_id: string
          invitation_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          department_id: string
          invitation_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          department_id?: string
          invitation_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invitation_departments_department_fk"
            columns: ["department_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "workspace_departments"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "workspace_invitation_departments_invitation_fk"
            columns: ["invitation_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "workspace_invitations"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      workspace_invitation_idempotency: {
        Row: {
          actor_id: string | null
          completed_at: string | null
          created_at: string
          expires_at: string
          invitation_id: string | null
          key: string
          operation: string
          request_fingerprint: string | null
          response_digest: string | null
          result_code: string | null
          result_state: string
          safe_result: Json | null
          scope_kind: string
          workspace_id: string | null
        }
        Insert: {
          actor_id?: string | null
          completed_at?: string | null
          created_at?: string
          expires_at?: string
          invitation_id?: string | null
          key: string
          operation: string
          request_fingerprint?: string | null
          response_digest?: string | null
          result_code?: string | null
          result_state: string
          safe_result?: Json | null
          scope_kind: string
          workspace_id?: string | null
        }
        Update: {
          actor_id?: string | null
          completed_at?: string | null
          created_at?: string
          expires_at?: string
          invitation_id?: string | null
          key?: string
          operation?: string
          request_fingerprint?: string | null
          response_digest?: string | null
          result_code?: string | null
          result_state?: string
          safe_result?: Json | null
          scope_kind?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      workspace_invitation_jobs: {
        Row: {
          attempt_count: number
          available_at: string
          channel: string
          claim_expires_at: string | null
          claim_token: string | null
          created_at: string
          derivation_key_version: number | null
          destination_hash: string
          email_token_generation: number | null
          id: string
          idempotency_key: string
          invitation_id: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          notification_generation: number
          otp_id: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          attempt_count?: number
          available_at?: string
          channel: string
          claim_expires_at?: string | null
          claim_token?: string | null
          created_at?: string
          derivation_key_version?: number | null
          destination_hash: string
          email_token_generation?: number | null
          id?: string
          idempotency_key: string
          invitation_id: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          notification_generation: number
          otp_id?: string | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          attempt_count?: number
          available_at?: string
          channel?: string
          claim_expires_at?: string | null
          claim_token?: string | null
          created_at?: string
          derivation_key_version?: number | null
          destination_hash?: string
          email_token_generation?: number | null
          id?: string
          idempotency_key?: string
          invitation_id?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          notification_generation?: number
          otp_id?: string | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invitation_jobs_invitation_fk"
            columns: ["invitation_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "workspace_invitations"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      workspace_invitation_otps: {
        Row: {
          attempts: number
          code_digest: string
          consumed_at: string | null
          created_at: string
          email_normalized: string
          expires_at: string
          id: string
          invitation_id: string
          ip_hash: string | null
          manual_token_generation: number
          manual_token_id: string
          max_attempts: number
          notification_generation: number
          purpose: string
          revoked_at: string | null
          workspace_id: string
        }
        Insert: {
          attempts?: number
          code_digest: string
          consumed_at?: string | null
          created_at?: string
          email_normalized: string
          expires_at: string
          id?: string
          invitation_id: string
          ip_hash?: string | null
          manual_token_generation: number
          manual_token_id: string
          max_attempts?: number
          notification_generation: number
          purpose?: string
          revoked_at?: string | null
          workspace_id: string
        }
        Update: {
          attempts?: number
          code_digest?: string
          consumed_at?: string | null
          created_at?: string
          email_normalized?: string
          expires_at?: string
          id?: string
          invitation_id?: string
          ip_hash?: string | null
          manual_token_generation?: number
          manual_token_id?: string
          max_attempts?: number
          notification_generation?: number
          purpose?: string
          revoked_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invitation_otps_invitation_fk"
            columns: ["invitation_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "workspace_invitations"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "workspace_invitation_otps_manual_token_id_fkey"
            columns: ["manual_token_id"]
            isOneToOne: false
            referencedRelation: "workspace_invitation_tokens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invitation_otps_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_invitation_proofs: {
        Row: {
          consumed_at: string | null
          created_at: string
          email_normalized: string
          expires_at: string
          id: string
          invitation_id: string
          manual_token_generation: number
          manual_token_id: string
          notification_generation: number
          otp_id: string
          proof_hash: string
          purpose: string
          revoked_at: string | null
          workspace_id: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          email_normalized: string
          expires_at: string
          id?: string
          invitation_id: string
          manual_token_generation: number
          manual_token_id: string
          notification_generation: number
          otp_id: string
          proof_hash: string
          purpose?: string
          revoked_at?: string | null
          workspace_id: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          email_normalized?: string
          expires_at?: string
          id?: string
          invitation_id?: string
          manual_token_generation?: number
          manual_token_id?: string
          notification_generation?: number
          otp_id?: string
          proof_hash?: string
          purpose?: string
          revoked_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invitation_proofs_invitation_fk"
            columns: ["invitation_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "workspace_invitations"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "workspace_invitation_proofs_manual_token_id_fkey"
            columns: ["manual_token_id"]
            isOneToOne: false
            referencedRelation: "workspace_invitation_tokens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invitation_proofs_otp_id_fkey"
            columns: ["otp_id"]
            isOneToOne: false
            referencedRelation: "workspace_invitation_otps"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invitation_proofs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_invitation_tokens: {
        Row: {
          consumed_at: string | null
          created_at: string
          derivation_key_version: number | null
          expires_at: string
          id: string
          invitation_id: string
          notification_generation: number
          purpose: string
          revoked_at: string | null
          token_generation: number
          token_hash: string
          token_prefix: string
          workspace_id: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          derivation_key_version?: number | null
          expires_at: string
          id?: string
          invitation_id: string
          notification_generation?: number
          purpose: string
          revoked_at?: string | null
          token_generation?: number
          token_hash: string
          token_prefix: string
          workspace_id: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          derivation_key_version?: number | null
          expires_at?: string
          id?: string
          invitation_id?: string
          notification_generation?: number
          purpose?: string
          revoked_at?: string | null
          token_generation?: number
          token_hash?: string
          token_prefix?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invitation_tokens_invitation_fk"
            columns: ["invitation_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "workspace_invitations"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "workspace_invitation_tokens_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          archived_at: string | null
          created_at: string
          created_by: string
          expired_at: string | null
          expires_at: string | null
          first_name: string | null
          id: string
          invitation_flow_version: number
          invited_email: string | null
          invited_email_normalized: string | null
          invited_phone_e164: string | null
          job_title: string | null
          last_email_status: string | null
          last_name: string | null
          last_sms_status: string | null
          locale: string | null
          max_uses: number
          member_type: string | null
          notification_generation: number
          revoked_at: string | null
          revoked_by: string | null
          revoked_reason: string | null
          role: Database["public"]["Enums"]["workspace_role"]
          staff_code: string | null
          status: string
          token: string | null
          use_count: number
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          archived_at?: string | null
          created_at?: string
          created_by: string
          expired_at?: string | null
          expires_at?: string | null
          first_name?: string | null
          id?: string
          invitation_flow_version?: number
          invited_email?: string | null
          invited_email_normalized?: string | null
          invited_phone_e164?: string | null
          job_title?: string | null
          last_email_status?: string | null
          last_name?: string | null
          last_sms_status?: string | null
          locale?: string | null
          max_uses?: number
          member_type?: string | null
          notification_generation?: number
          revoked_at?: string | null
          revoked_by?: string | null
          revoked_reason?: string | null
          role?: Database["public"]["Enums"]["workspace_role"]
          staff_code?: string | null
          status?: string
          token?: string | null
          use_count?: number
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          archived_at?: string | null
          created_at?: string
          created_by?: string
          expired_at?: string | null
          expires_at?: string | null
          first_name?: string | null
          id?: string
          invitation_flow_version?: number
          invited_email?: string | null
          invited_email_normalized?: string | null
          invited_phone_e164?: string | null
          job_title?: string | null
          last_email_status?: string | null
          last_name?: string | null
          last_sms_status?: string | null
          locale?: string | null
          max_uses?: number
          member_type?: string | null
          notification_generation?: number
          revoked_at?: string | null
          revoked_by?: string | null
          revoked_reason?: string | null
          role?: Database["public"]["Enums"]["workspace_role"]
          staff_code?: string | null
          status?: string
          token?: string | null
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
      workspace_limit_overrides: {
        Row: {
          admin_notes: string | null
          created_at: string
          id: string
          limit_key: string
          limit_value: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          admin_notes?: string | null
          created_at?: string
          id?: string
          limit_key: string
          limit_value: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          admin_notes?: string | null
          created_at?: string
          id?: string
          limit_key?: string
          limit_value?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_limit_overrides_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_member_details: {
        Row: {
          first_name: string
          invitation_id: string | null
          invited_by: string | null
          job_title: string | null
          joined_at: string
          last_name: string
          member_type: string
          staff_code: string | null
          updated_at: string
          user_id: string
          work_email_normalized: string
          work_phone_e164: string
          workspace_id: string
        }
        Insert: {
          first_name: string
          invitation_id?: string | null
          invited_by?: string | null
          job_title?: string | null
          joined_at?: string
          last_name: string
          member_type: string
          staff_code?: string | null
          updated_at?: string
          user_id: string
          work_email_normalized: string
          work_phone_e164: string
          workspace_id: string
        }
        Update: {
          first_name?: string
          invitation_id?: string | null
          invited_by?: string | null
          job_title?: string | null
          joined_at?: string
          last_name?: string
          member_type?: string
          staff_code?: string | null
          updated_at?: string
          user_id?: string
          work_email_normalized?: string
          work_phone_e164?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_member_details_invitation_id_fkey"
            columns: ["invitation_id"]
            isOneToOne: false
            referencedRelation: "workspace_invitations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_member_details_member_fk"
            columns: ["workspace_id", "user_id"]
            isOneToOne: true
            referencedRelation: "workspace_members"
            referencedColumns: ["workspace_id", "user_id"]
          },
        ]
      }
      workspace_member_details_history: {
        Row: {
          first_name: string | null
          id: string
          invitation_id: string | null
          invited_by: string | null
          job_title: string | null
          joined_at: string | null
          last_name: string | null
          member_type: string | null
          offboarded_at: string
          offboarded_by: string | null
          reason: string | null
          staff_code: string | null
          user_id: string | null
          work_email_normalized: string | null
          work_phone_e164: string | null
          workspace_id: string
        }
        Insert: {
          first_name?: string | null
          id?: string
          invitation_id?: string | null
          invited_by?: string | null
          job_title?: string | null
          joined_at?: string | null
          last_name?: string | null
          member_type?: string | null
          offboarded_at?: string
          offboarded_by?: string | null
          reason?: string | null
          staff_code?: string | null
          user_id?: string | null
          work_email_normalized?: string | null
          work_phone_e164?: string | null
          workspace_id: string
        }
        Update: {
          first_name?: string | null
          id?: string
          invitation_id?: string | null
          invited_by?: string | null
          job_title?: string | null
          joined_at?: string | null
          last_name?: string | null
          member_type?: string | null
          offboarded_at?: string
          offboarded_by?: string | null
          reason?: string | null
          staff_code?: string | null
          user_id?: string | null
          work_email_normalized?: string | null
          work_phone_e164?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_member_details_history_invitation_id_fkey"
            columns: ["invitation_id"]
            isOneToOne: false
            referencedRelation: "workspace_invitations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_member_details_history_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_member_details_history_workspace_id_fkey"
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
          suspend_reason: string | null
          suspended_at: string | null
          suspended_by: string | null
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          suspend_reason?: string | null
          suspended_at?: string | null
          suspended_by?: string | null
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          suspend_reason?: string | null
          suspended_at?: string | null
          suspended_by?: string | null
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_user_id_profiles_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
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
      workspace_plugin_installations: {
        Row: {
          created_at: string
          id: string
          installed_at: string
          installed_by: string | null
          instance_key: string
          plugin_id: string
          settings: Json
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          installed_at?: string
          installed_by?: string | null
          instance_key?: string
          plugin_id: string
          settings?: Json
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          installed_at?: string
          installed_by?: string | null
          instance_key?: string
          plugin_id?: string
          settings?: Json
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_plugin_installations_workspace_id_fkey"
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
      workspace_seat_entitlement_mode: {
        Row: {
          config_version: number
          id: boolean
          mode: string
          seat_limit: number | null
          source: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          config_version?: number
          id?: boolean
          mode: string
          seat_limit?: number | null
          source: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          config_version?: number
          id?: boolean
          mode?: string
          seat_limit?: number | null
          source?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
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
          billing_anchor_at: string | null
          billing_engine_version: string
          billing_interval: string | null
          billing_v2_effective_at: string | null
          cancel_at_period_end: boolean | null
          canceled_at: string | null
          created_at: string | null
          current_period_end: string | null
          current_period_id: string | null
          current_period_start: string | null
          free_fallback_at: string | null
          grace_period_ends_at: string | null
          id: string
          metadata: Json | null
          next_invoice_at: string | null
          next_plan_id: string | null
          past_due_since: string | null
          pending_change_type: string | null
          plan_id: string | null
          provider_customer_id: string | null
          provider_name: string
          provider_subscription_id: string | null
          status: string
          trial_end: string | null
          trial_start: string | null
          updated_at: string | null
          v2_allowance_effective_period_id: string | null
          workspace_id: string
        }
        Insert: {
          billing_anchor_at?: string | null
          billing_engine_version?: string
          billing_interval?: string | null
          billing_v2_effective_at?: string | null
          cancel_at_period_end?: boolean | null
          canceled_at?: string | null
          created_at?: string | null
          current_period_end?: string | null
          current_period_id?: string | null
          current_period_start?: string | null
          free_fallback_at?: string | null
          grace_period_ends_at?: string | null
          id?: string
          metadata?: Json | null
          next_invoice_at?: string | null
          next_plan_id?: string | null
          past_due_since?: string | null
          pending_change_type?: string | null
          plan_id?: string | null
          provider_customer_id?: string | null
          provider_name?: string
          provider_subscription_id?: string | null
          status?: string
          trial_end?: string | null
          trial_start?: string | null
          updated_at?: string | null
          v2_allowance_effective_period_id?: string | null
          workspace_id: string
        }
        Update: {
          billing_anchor_at?: string | null
          billing_engine_version?: string
          billing_interval?: string | null
          billing_v2_effective_at?: string | null
          cancel_at_period_end?: boolean | null
          canceled_at?: string | null
          created_at?: string | null
          current_period_end?: string | null
          current_period_id?: string | null
          current_period_start?: string | null
          free_fallback_at?: string | null
          grace_period_ends_at?: string | null
          id?: string
          metadata?: Json | null
          next_invoice_at?: string | null
          next_plan_id?: string | null
          past_due_since?: string | null
          pending_change_type?: string | null
          plan_id?: string | null
          provider_customer_id?: string | null
          provider_name?: string
          provider_subscription_id?: string | null
          status?: string
          trial_end?: string | null
          trial_start?: string | null
          updated_at?: string | null
          v2_allowance_effective_period_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_subscriptions_current_period_id_fkey"
            columns: ["current_period_id"]
            isOneToOne: false
            referencedRelation: "billing_subscription_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_subscriptions_next_plan_id_fkey"
            columns: ["next_plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_subscriptions_next_plan_id_fkey"
            columns: ["next_plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans_public"
            referencedColumns: ["id"]
          },
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
            foreignKeyName: "workspace_subscriptions_v2_allowance_effective_period_id_fkey"
            columns: ["v2_allowance_effective_period_id"]
            isOneToOne: false
            referencedRelation: "billing_subscription_periods"
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
          call_minutes_used: number
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
          call_minutes_used?: number
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
          call_minutes_used?: number
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
          {
            foreignKeyName: "workspaces_owner_id_profiles_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
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
      _gv_create_challenge_row: {
        Args: {
          _channel: string
          _code_digest: string
          _destination_hash: string
          _destination_normalized: string
          _generation: number
          _global_max_per_window: number
          _global_window_seconds: number
          _handle: string
          _key_version: number
          _locale: string
          _max_attempts: number
          _max_per_window: number
          _max_sends: number
          _purpose: string
          _rate_window_seconds: number
          _request_ip_hash: string
          _resend_cooldown_seconds: number
          _subject_kind: string
          _subject_ref: string
          _subject_ref_hash: string
          _ttl_seconds: number
          _workspace_id: string
        }
        Returns: Json
      }
      _gv_do_request: { Args: { _args: Json }; Returns: Json }
      _gv_do_resend: { Args: { _args: Json }; Returns: Json }
      _gv_do_revoke: { Args: { _args: Json }; Returns: Json }
      _gv_do_verify: { Args: { _args: Json }; Returns: Json }
      accept_invitation_existing_context_v2: {
        Args: {
          _handle_hash: string
          _ip?: string
          _locale?: string
          _privacy_version_id: string
          _session_email_normalized: string
          _session_user_id: string
          _terms_version_id: string
          _user_agent?: string
        }
        Returns: Json
      }
      accept_invitation_existing_user_v2: {
        Args: {
          _ip?: string
          _locale?: string
          _privacy_version_id: string
          _purpose: string
          _session_email_normalized: string
          _session_user_id: string
          _terms_version_id: string
          _token_hash: string
          _user_agent?: string
        }
        Returns: Json
      }
      accept_invitation_new_user_v2: {
        Args: {
          _acceptance_method: string
          _ip?: string
          _locale?: string
          _password_hash: string
          _privacy_version_id: string
          _proof_hash: string
          _purpose: string
          _terms_version_id: string
          _token_hash: string
          _user_agent?: string
          _user_id: string
        }
        Returns: Json
      }
      accept_workspace_invitation: { Args: { _token: string }; Returns: Json }
      accept_workspace_invitation_as: {
        Args: { _token: string; _user_id: string }
        Returns: Json
      }
      account_list_auth_sessions: {
        Args: { _user_id: string }
        Returns: {
          created_at: string
          id: string
          ip: string
          not_after: string
          refreshed_at: string
          updated_at: string
          user_agent: string
          user_id: string
        }[]
      }
      account_revoke_auth_sessions: {
        Args: { _all_except?: string; _session_id?: string; _user_id: string }
        Returns: number
      }
      activate_auto_actions: { Args: never; Returns: Json }
      admin_apply_schema: {
        Args: { _actor_user_id: string; _statements: Json }
        Returns: Json
      }
      admin_change_user_email: {
        Args: { _new_email: string; _user_id: string }
        Returns: {
          changed: boolean
          new_email: string
          old_email: string
          sessions_revoked: number
        }[]
      }
      admin_count_profiles:
        | { Args: never; Returns: number }
        | {
            Args: {
              _actor_user_id: string
              _phone_status?: string
              _search?: string
            }
            Returns: number
          }
      admin_count_workspaces:
        | { Args: never; Returns: number }
        | {
            Args: {
              _actor_user_id: string
              _phone_status?: string
              _search?: string
            }
            Returns: number
          }
      admin_delete_user: {
        Args: { _actor_user_id: string; _user_id: string }
        Returns: Json
      }
      admin_delete_workspace: {
        Args: { _actor_user_id: string; _workspace_id: string }
        Returns: boolean
      }
      admin_export_database: {
        Args: { _actor_user_id: string; _scope?: string }
        Returns: Json
      }
      admin_export_schema_ddl: {
        Args: { _actor_user_id: string }
        Returns: string[]
      }
      admin_export_table: {
        Args: {
          _actor_user_id: string
          _limit?: number
          _offset?: number
          _table: string
        }
        Returns: Json
      }
      admin_get_user_detail: {
        Args: { _actor_user_id: string; _user_id: string }
        Returns: Json
      }
      admin_get_workspace_detail: {
        Args: { _actor_user_id: string; _workspace_id: string }
        Returns: Json
      }
      admin_list_export_tables: {
        Args: { _actor_user_id: string; _scope?: string }
        Returns: string[]
      }
      admin_list_login_attempts: {
        Args: { _email: string; _limit?: number }
        Returns: Json
      }
      admin_list_profiles:
        | {
            Args: {
              _actor_user_id: string
              _limit?: number
              _offset?: number
              _phone_status?: string
              _search?: string
              _sort?: string
            }
            Returns: Json
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
      admin_list_realtime_audit: { Args: { _limit?: number }; Returns: Json }
      admin_list_workspaces:
        | {
            Args: {
              _actor_user_id: string
              _limit?: number
              _offset?: number
              _phone_status?: string
              _search?: string
              _sort?: string
            }
            Returns: Json
          }
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
      admin_purge_database: {
        Args: { _actor_user_id: string; _scope?: string }
        Returns: Json
      }
      admin_reset_billing_data: { Args: { p_confirm: string }; Returns: Json }
      admin_reset_identity_tables: { Args: never; Returns: string[] }
      admin_reset_preserved_tables: {
        Args: { _scope: string }
        Returns: string[]
      }
      admin_reset_settings_tables: { Args: never; Returns: string[] }
      admin_reset_target_tables: { Args: { _scope: string }; Returns: string[] }
      admin_restore_database: {
        Args: { _actor_user_id: string; _payload: Json }
        Returns: Json
      }
      admin_security_stats: { Args: never; Returns: Json }
      admin_set_password_and_revoke_sessions: {
        Args: { _new_password_hash: string; _user_id: string }
        Returns: number
      }
      admin_set_user_block_status: {
        Args: { _blocked: boolean; _user_id: string }
        Returns: number
      }
      advance_entitlement_fanout: {
        Args: {
          _claim_token: string
          _cursor_workspace_id: string
          _failed: number
          _id: string
          _lease_seconds?: number
          _processed: number
          _worker_id: string
        }
        Returns: boolean
      }
      ai_adjust_balance: {
        Args: {
          p_actor?: string
          p_amount: number
          p_command_key: string
          p_reason: string
          p_workspace_id: string
        }
        Returns: string
      }
      ai_available_balance: {
        Args: { p_workspace_id: string }
        Returns: number
      }
      ai_begin_run: {
        Args: {
          p_channel: string
          p_conversation_id: string
          p_entry_point: string
          p_fx_id: string
          p_fx_rate: number
          p_mode: string
          p_operation_key: string
          p_overage_policy: string
          p_request_hash: string
          p_sell_multiplier: number
          p_sell_policy_id: string
          p_workspace_id: string
        }
        Returns: {
          billing_currency: string
          billing_fx_id: string | null
          billing_fx_rate: number | null
          billing_quality: string
          channel: string | null
          conversation_id: string | null
          cost_source: string
          created_at: string
          customer_charge_irr: number
          entry_point: string
          fallback_kind: string | null
          finished_at: string | null
          id: string
          internal_cost_irr: number
          mode: string
          operation_idempotency_key: string
          operation_request_hash: string
          overage_policy: string
          platform_absorbed_amount: number
          primary_model: string | null
          primary_provider: string | null
          provider_cost_usd: number
          reservation_id: string | null
          sell_multiplier: number | null
          sell_policy_id: string | null
          started_at: string
          status: string
          unresolved_reason: string | null
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "ai_runs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      ai_billing_release_recovery_lease: {
        Args: { _owner: string }
        Returns: boolean
      }
      ai_billing_try_acquire_recovery_lease: {
        Args: { _owner: string; _ttl_seconds?: number }
        Returns: boolean
      }
      ai_expire_lots: { Args: never; Returns: number }
      ai_grant_allowance: {
        Args: {
          p_allowance_source: string
          p_amount: number
          p_billing_cycle_id: string
          p_command_key?: string
          p_expires_at: string
          p_workspace_id: string
        }
        Returns: string
      }
      ai_ingest_usage_event: {
        Args: {
          p_component_type: string
          p_payload: Json
          p_step_id: string
          p_usage_event_key: string
        }
        Returns: string
      }
      ai_open_step: {
        Args: {
          p_attempt_no: number
          p_provider: string
          p_requested_model: string
          p_run_id: string
          p_step_kind: string
          p_step_seq: number
        }
        Returns: string
      }
      ai_publish_exchange_rate: {
        Args: { p_actor?: string; p_from: string; p_rate: number; p_to: string }
        Returns: string
      }
      ai_publish_rate_card: {
        Args: {
          p_actor?: string
          p_components: Json
          p_currency: string
          p_model_key: string
          p_notes?: string
          p_provider: string
        }
        Returns: string
      }
      ai_publish_sell_policy: {
        Args: {
          p_actor?: string
          p_multiplier: number
          p_overage_policy: string
          p_scope: string
          p_workspace_id: string
        }
        Returns: string
      }
      ai_purchase_credit: {
        Args: {
          p_amount: number
          p_command_key: string
          p_reason?: string
          p_workspace_id: string
        }
        Returns: string
      }
      ai_reconcile_wallet: { Args: { p_workspace_id: string }; Returns: Json }
      ai_refund_run: {
        Args: {
          p_actor?: string
          p_amount: number
          p_command_key: string
          p_reason: string
          p_run_id: string
        }
        Returns: Json
      }
      ai_release_reservation: {
        Args: { p_reservation_id: string }
        Returns: undefined
      }
      ai_reserve: {
        Args: {
          p_amount: number
          p_command_key: string
          p_run_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      ai_settle_run: {
        Args: {
          p_billing_cycle_id: string
          p_command_key: string
          p_customer_charge_irr: number
          p_internal_cost_irr: number
          p_provider_cost_usd: number
          p_run_id: string
        }
        Returns: Json
      }
      ai_topup_reservation: {
        Args: { p_delta: number; p_run_id: string }
        Returns: number
      }
      ai_wallet_lock: {
        Args: { p_workspace_id: string }
        Returns: {
          available_amount: number
          created_at: string
          currency: string
          lifetime_charged: number
          reserved_amount: number
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "workspace_ai_wallets"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      ai_wallet_project: {
        Args: { p_workspace_id: string }
        Returns: undefined
      }
      archive_invitation_v2: {
        Args: { _actor_id: string; _invitation_id: string }
        Returns: Json
      }
      billing_activate_due_periods: {
        Args: { p_limit?: number }
        Returns: Json
      }
      billing_activate_period: { Args: { p_period_id: string }; Returns: Json }
      billing_apply_invoice_effects: {
        Args: { p_invoice_id: string }
        Returns: Json
      }
      billing_apply_subscription_payment: {
        Args: {
          p_interval: string
          p_now?: string
          p_payment_intent_id: string
          p_plan_id: string
          p_provider_name: string
          p_workspace_id: string
        }
        Returns: Json
      }
      billing_begin_collection: {
        Args: {
          p_amount_irr: number
          p_channel: string
          p_command_key: string
          p_intent_id?: string
          p_invoice_id: string
          p_ttl_seconds?: number
        }
        Returns: Json
      }
      billing_expire_stale_collections: {
        Args: { p_invoice_id?: string }
        Returns: number
      }
      billing_legacy_allowance_active: {
        Args: { p_workspace_id: string }
        Returns: boolean
      }
      billing_recover_unapplied_invoices: {
        Args: { p_limit?: number }
        Returns: Json
      }
      billing_release_collection: {
        Args: { p_collection_id: string; p_reason?: string }
        Returns: Json
      }
      billing_retire_legacy_allowance: {
        Args: { p_workspace_id: string }
        Returns: number
      }
      billing_settle_invoice: {
        Args: {
          p_amount_irr: number
          p_command_key: string
          p_invoice_id: string
          p_payment_id?: string
          p_source: string
          p_wallet_entry_id?: string
        }
        Returns: Json
      }
      billing_v2_activate: {
        Args: { p_actor_id?: string; p_reason?: string; p_workspace_id: string }
        Returns: Json
      }
      billing_v2_add_interval: {
        Args: { p_count?: number; p_interval: string; p_ts: string }
        Returns: string
      }
      billing_v2_apply_free_fallback: {
        Args: { p_workspace_id: string }
        Returns: Json
      }
      billing_v2_apply_period_allowance: {
        Args: { p_period_id: string }
        Returns: Json
      }
      billing_v2_billing_recipient: {
        Args: { p_workspace_id: string }
        Returns: Json
      }
      billing_v2_cancel_invoice_notifications: {
        Args: { p_invoice_id: string; p_reason?: string; p_types?: string[] }
        Returns: number
      }
      billing_v2_claim_jobs: {
        Args: { p_job_type: string; p_lease_seconds?: number; p_limit?: number }
        Returns: {
          attempt_count: number
          created_at: string
          dedupe_key: string
          id: string
          job_type: string
          last_error: string | null
          lease_until: string | null
          max_attempts: number
          next_attempt_at: string
          payload: Json
          result: Json | null
          status: string
          updated_at: string
          workspace_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "billing_v2_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      billing_v2_claim_notification_jobs: {
        Args: { p_lease_seconds?: number; p_limit?: number }
        Returns: {
          attempt_count: number
          channel: string
          created_at: string
          id: string
          idempotency_key: string
          invoice_id: string | null
          last_error: string | null
          lease_until: string | null
          locale: string | null
          max_attempts: number
          next_attempt_at: string
          notification_type: string
          payload: Json
          scheduled_at: string
          sent_at: string | null
          status: string
          subscription_id: string | null
          updated_at: string
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "billing_notification_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      billing_v2_complete_job: {
        Args: { p_job_id: string; p_result?: Json }
        Returns: undefined
      }
      billing_v2_complete_notification_job:
        | { Args: { p_job_id: string; p_result: Json }; Returns: Json }
        | {
            Args: { p_error?: string; p_job_id: string; p_status?: string }
            Returns: undefined
          }
      billing_v2_current_entitlement_cycle: {
        Args: { p_workspace_id: string }
        Returns: Json
      }
      billing_v2_defer_job: {
        Args: { p_job_id: string; p_reason?: string }
        Returns: undefined
      }
      billing_v2_document_number: { Args: never; Returns: string }
      billing_v2_dunning_metrics: { Args: never; Returns: Json }
      billing_v2_dunning_snapshot: {
        Args: { p_invoice_id: string }
        Returns: Json
      }
      billing_v2_enqueue_job: {
        Args: {
          p_dedupe_key: string
          p_job_type: string
          p_payload?: Json
          p_workspace_id: string
        }
        Returns: string
      }
      billing_v2_enqueue_notification: {
        Args: {
          p_channel: string
          p_invoice_id?: string
          p_payload?: Json
          p_scheduled_at?: string
          p_suffix?: string
          p_type: string
          p_workspace_id: string
        }
        Returns: string
      }
      billing_v2_ensure_free_period: {
        Args: { p_workspace_id: string }
        Returns: Json
      }
      billing_v2_ensure_period_cycles: {
        Args: { p_period_id: string }
        Returns: Json
      }
      billing_v2_evaluate_cutover: {
        Args: { p_workspace_id: string }
        Returns: Json
      }
      billing_v2_fail_job: {
        Args: { p_error: string; p_job_id: string }
        Returns: undefined
      }
      billing_v2_fail_notification_job: {
        Args: { p_error: string; p_job_id: string }
        Returns: undefined
      }
      billing_v2_grant_cycle_allowance: {
        Args: { p_cycle_id: string }
        Returns: Json
      }
      billing_v2_issue_renewal_invoice: {
        Args: { p_force?: boolean; p_workspace_id: string }
        Returns: Json
      }
      billing_v2_note_worker_run: {
        Args: {
          p_batch: number
          p_error?: string
          p_failures: number
          p_worker: string
        }
        Returns: undefined
      }
      billing_v2_period_cycles_grant: {
        Args: { p_period_id: string }
        Returns: boolean
      }
      billing_v2_period_monthly_allowance: {
        Args: {
          p_period: Database["public"]["Tables"]["billing_subscription_periods"]["Row"]
        }
        Returns: number
      }
      billing_v2_policy_for: { Args: { p_workspace_id: string }; Returns: Json }
      billing_v2_process_due_invoice: {
        Args: { p_invoice_id: string }
        Returns: Json
      }
      billing_v2_resolve_billing_recipient: {
        Args: { p_workspace_id: string }
        Returns: Json
      }
      billing_v2_restore_subscription: {
        Args: { p_workspace_id: string }
        Returns: Json
      }
      billing_v2_run_dunning: { Args: { p_limit?: number }; Returns: Json }
      billing_v2_run_entitlement_cycles: {
        Args: { p_limit?: number }
        Returns: Json
      }
      billing_v2_run_grace_expiry: { Args: { p_limit?: number }; Returns: Json }
      billing_v2_run_invoice_scheduler: {
        Args: { p_limit?: number }
        Returns: Json
      }
      billing_v2_run_period_activation: {
        Args: { p_limit?: number }
        Returns: Json
      }
      billing_v2_run_wallet_autopay: {
        Args: { p_limit?: number }
        Returns: Json
      }
      billing_v2_schedule_invoice_notifications: {
        Args: { p_invoice_id: string }
        Returns: Json
      }
      billing_v2_scheduler_health: { Args: never; Returns: Json }
      billing_v2_set_state: {
        Args: {
          p_actor_id?: string
          p_break_glass?: boolean
          p_reason?: string
          p_state: string
          p_workspace_id: string
        }
        Returns: Json
      }
      billing_v2_skip_notification_job: {
        Args: { p_job_id: string; p_reason?: string }
        Returns: Json
      }
      billing_v2_state: { Args: { p_workspace_id: string }; Returns: string }
      billing_v2_sync_period_cycles: {
        Args: { p_period_id: string }
        Returns: Json
      }
      billing_v2_validate_policy: { Args: never; Returns: Json }
      billing_v2_wallet_autopay_invoice: {
        Args: { p_invoice_id: string }
        Returns: Json
      }
      billing_v2_wallet_deposit_config: { Args: never; Returns: Json }
      billing_wallet_admin_adjust: {
        Args: {
          p_actor_id?: string
          p_amount_irr: number
          p_command_key: string
          p_reason: string
          p_workspace_id: string
        }
        Returns: Json
      }
      billing_wallet_append: {
        Args: {
          p_actor_id?: string
          p_amount_irr: number
          p_command_key: string
          p_deposit_id?: string
          p_entry_type: string
          p_invoice_id?: string
          p_metadata?: Json
          p_payment_id?: string
          p_reason?: string
          p_workspace_id: string
        }
        Returns: {
          actor_id: string | null
          amount_irr: number
          balance_after_irr: number
          command_key: string
          created_at: string
          entry_type: string
          id: string
          invoice_id: string | null
          metadata: Json
          payment_id: string | null
          reason: string | null
          wallet_deposit_id: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "billing_wallet_ledger"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      billing_wallet_apply_deposit: {
        Args: {
          p_amount_irr: number
          p_deposit_id: string
          p_payment_id?: string
        }
        Returns: Json
      }
      billing_wallet_lock: {
        Args: { p_workspace_id: string }
        Returns: {
          auto_pay_enabled: boolean | null
          available_balance_irr: number
          created_at: string
          currency: string
          frozen: boolean
          id: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "billing_wallet_accounts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      billing_wallet_pay_invoice: {
        Args: { p_actor_id?: string; p_invoice_id: string }
        Returns: Json
      }
      billing_wallet_reconcile: {
        Args: { p_workspace_id: string }
        Returns: Json
      }
      billing_wallet_refund: {
        Args: {
          p_actor_id?: string
          p_amount_irr: number
          p_command_key: string
          p_reason?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      bootstrap_admin: { Args: { _user_id: string }; Returns: boolean }
      bulk_create_contacts: {
        Args: { _contacts: Json; _workspace_id: string }
        Returns: {
          inserted: number
        }[]
      }
      bump_usage_counter_for: {
        Args: {
          _amount: number
          _at: string
          _counter_name: string
          _workspace_id: string
        }
        Returns: undefined
      }
      business_metrics_rollup_and_prune: { Args: never; Returns: Json }
      change_password_and_revoke_sessions: {
        Args: {
          _except_session_id?: string
          _new_password_hash: string
          _user_id: string
        }
        Returns: number
      }
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
      claim_channel_jobs: {
        Args: {
          _job_types?: string[]
          _lease_seconds?: number
          _limit?: number
          _worker_id: string
        }
        Returns: {
          attempt_count: number
          claim_expires_at: string
          claim_token: string
          id: string
          integration_id: string
          job_type: string
          max_attempts: number
          payload: Json
          provider: string
          workspace_id: string
        }[]
      }
      claim_channel_provider_account: {
        Args: {
          _external_account_id: string
          _integration_id: string
          _provider: string
        }
        Returns: string
      }
      claim_conversation: {
        Args: {
          p_conversation_id: string
          p_force?: boolean
          p_user_id: string
          p_workspace_id: string
        }
        Returns: {
          ai_state: string | null
          assigned_to: string | null
          contact_id: string | null
          created_at: string | null
          id: string
          is_spam: boolean
          metadata: Json
          priority: Database["public"]["Enums"]["conversation_priority"] | null
          spam_marked_at: string | null
          spam_marked_by: string | null
          status: Database["public"]["Enums"]["conversation_status"] | null
          subject: string | null
          tags: string[] | null
          updated_at: string | null
          visitor_session_id: string | null
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "conversations"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_entitlement_fanout_jobs: {
        Args: { _lease_seconds?: number; _limit?: number; _worker_id: string }
        Returns: {
          attempts: number
          claim_expires_at: string
          claim_token: string
          cursor_workspace_id: string
          failed_count: number
          id: string
          plan_id: string
          processed_count: number
          scope: string
          source: string
        }[]
      }
      claim_invitation_jobs: {
        Args: {
          _channels?: string[]
          _lease_seconds?: number
          _limit?: number
          _worker_id: string
        }
        Returns: {
          attempt_count: number
          available_at: string
          channel: string
          claim_expires_at: string | null
          claim_token: string | null
          created_at: string
          derivation_key_version: number | null
          destination_hash: string
          email_token_generation: number | null
          id: string
          idempotency_key: string
          invitation_id: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          notification_generation: number
          otp_id: string | null
          status: string
          updated_at: string
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "workspace_invitation_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_kb_change_events: {
        Args: { _lease_seconds?: number; _limit?: number; _worker_id: string }
        Returns: {
          attempts: number
          claim_expires_at: string
          claim_token: string
          event_type: string
          id: string
          workspace_id: string
        }[]
      }
      cleanup_expired_auth_tokens: { Args: never; Returns: undefined }
      cleanup_expired_widget_identity: { Args: never; Returns: undefined }
      complete_entitlement_fanout: {
        Args: {
          _claim_token: string
          _failed?: number
          _id: string
          _processed?: number
          _worker_id: string
        }
        Returns: boolean
      }
      complete_kb_change_events: {
        Args: { _claim_token: string; _ids: string[]; _worker_id: string }
        Returns: number
      }
      conversation_apply_post_send_action: {
        Args: {
          p_after_message_id: string
          p_allowed_from: string[]
          p_conversation_id: string
          p_target_status: string
          p_workspace_id: string
        }
        Returns: {
          blocked_reason: string
          changed: boolean
          changed_at: string
          new_status: string
        }[]
      }
      count_recent_login_failures: {
        Args: { _email: string; _ip: string; _window_minutes?: number }
        Returns: number
      }
      create_contact: {
        Args: {
          _avatar_url?: string
          _email?: string
          _metadata?: Json
          _name?: string
          _notes?: string
          _phone?: string
          _tags?: string[]
          _workspace_id: string
        }
        Returns: {
          avatar_url: string | null
          created_at: string | null
          email: string | null
          id: string
          is_spam: boolean
          metadata: Json | null
          name: string | null
          notes: string | null
          phone: string | null
          spam_marked_at: string | null
          spam_marked_by: string | null
          tags: string[] | null
          updated_at: string | null
          visitor_code: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "contacts"
          isOneToOne: true
          isSetofReturn: false
        }
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
      create_workspace_invitation_v2: {
        Args: {
          _actor_id: string
          _department_ids: string[]
          _email_destination_hash: string
          _email_job_idempotency_key: string
          _email_normalized: string
          _expires_at: string
          _first_name: string
          _job_title?: string
          _last_name: string
          _manual_token_expires_at: string
          _manual_token_hash: string
          _manual_token_prefix: string
          _member_type: string
          _phone_e164: string
          _role: Database["public"]["Enums"]["workspace_role"]
          _sms_destination_hash: string
          _sms_job_idempotency_key: string
          _staff_code?: string
          _workspace_id: string
        }
        Returns: Json
      }
      deduct_ai_credits: {
        Args: { _credits?: number; _period?: string; _workspace_id: string }
        Returns: Json
      }
      default_workspace_permission: {
        Args: { _permission_key: string; _role: string }
        Returns: boolean
      }
      defer_kb_change_events: {
        Args: {
          _claim_token: string
          _error_code: string
          _ids: string[]
          _retry_seconds?: number
          _worker_id: string
        }
        Returns: number
      }
      edit_workspace_invitation_v2: {
        Args: {
          _actor_id: string
          _department_ids: string[]
          _email_destination_hash?: string
          _email_job_idempotency_key?: string
          _email_normalized: string
          _expires_at: string
          _first_name: string
          _invitation_id: string
          _job_title?: string
          _last_name: string
          _member_type: string
          _phone_e164: string
          _role: Database["public"]["Enums"]["workspace_role"]
          _sms_destination_hash?: string
          _sms_job_idempotency_key?: string
          _staff_code?: string
        }
        Returns: Json
      }
      enqueue_entitlement_fanout: {
        Args: { _plan_id?: string; _scope: string; _source: string }
        Returns: string
      }
      enqueue_kb_catchup: { Args: { _workspace_id: string }; Returns: number }
      ensure_active_conversation: {
        Args: {
          p_contact_id?: string
          p_lock_key: string
          p_match_contact_id?: string
          p_match_session_id?: string
          p_match_thread_key?: string
          p_metadata?: Json
          p_subject?: string
          p_visitor_session_id?: string
          p_workspace_id: string
        }
        Returns: {
          created: boolean
          id: string
          matched_by: string
        }[]
      }
      evaluate_alert_rules: { Args: never; Returns: Json }
      expire_invitations_v2: { Args: { _limit?: number }; Returns: number }
      expire_stale_trials: { Args: never; Returns: number }
      fail_entitlement_fanout: {
        Args: {
          _claim_token: string
          _error_code: string
          _id: string
          _max_attempts?: number
          _retry_seconds?: number
          _worker_id: string
        }
        Returns: boolean
      }
      fail_kb_change_events: {
        Args: {
          _claim_token: string
          _error_code: string
          _error_detail?: string
          _ids: string[]
          _max_attempts?: number
          _permanent?: boolean
          _retry_seconds?: number
          _worker_id: string
        }
        Returns: number
      }
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
      gv_admin_consumer_implemented: {
        Args: { _purpose: string }
        Returns: boolean
      }
      gv_admin_default_settings: { Args: { _purpose: string }; Returns: Json }
      gv_admin_deployment_allowlisted: {
        Args: { _purpose: string }
        Returns: boolean
      }
      gv_admin_effective_enabled: {
        Args: { _purpose: string }
        Returns: boolean
      }
      gv_admin_purge_expired_idempotency: {
        Args: { _limit: number }
        Returns: number
      }
      gv_admin_sanitize_settings: {
        Args: {
          _s: Database["public"]["Tables"]["verification_purpose_settings"]["Row"]
        }
        Returns: Json
      }
      gv_admin_update_purpose_settings: {
        Args: {
          _action: string
          _actor_profile_id: string
          _admin_enabled: boolean
          _default_locale: string
          _expected_revision: number
          _global_rate_limit_enabled: boolean
          _global_rate_limit_max_per_window: number
          _global_rate_limit_window_seconds: number
          _ip_hash: string
          _locale: string
          _max_sends_per_window: number
          _max_verification_attempts: number
          _otp_length: number
          _otp_ttl_seconds: number
          _proof_ttl_seconds: number
          _purpose: string
          _rate_window_seconds: number
          _request_id: string
          _resend_cooldown_seconds: number
          _user_agent: string
        }
        Returns: Json
      }
      gv_consume_verification_proof: {
        Args: {
          _channel: string
          _consumed_by_context: string
          _proof_hash: string
          _purpose: string
          _subject_ref_hash: string
          _workspace_id: string
        }
        Returns: Json
      }
      gv_execute_idempotent: {
        Args: {
          _actor_ref_hash: string
          _args: Json
          _key: string
          _operation: string
          _purpose: string
          _request_fingerprint: string
          _scope_kind: string
          _workspace_id: string
        }
        Returns: Json
      }
      gv_finalize_verification_delivery: {
        Args: {
          _attempt_token: string
          _error_code: string
          _error_message: string
          _key: string
          _outcome: string
          _provider_message_id: string
          _provider_name: string
        }
        Returns: Json
      }
      gv_get_verification_status: { Args: { _handle: string }; Returns: Json }
      gv_is_purpose_enabled: { Args: { _purpose: string }; Returns: boolean }
      gv_prepare_verification_delivery: {
        Args: {
          _actor_ref_hash: string
          _args: Json
          _key: string
          _operation: string
          _purpose: string
          _request_fingerprint: string
          _scope_kind: string
          _workspace_id: string
        }
        Returns: Json
      }
      gv_purge_expired_idempotency: {
        Args: { _limit: number }
        Returns: number
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      has_workspace_permission: {
        Args: {
          _permission_key: string
          _user_id: string
          _workspace_id: string
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
      mask_phone_e164: { Args: { _phone: string }; Returns: string }
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
      observability_release_ticker_lease: {
        Args: { _name: string; _owner: string }
        Returns: boolean
      }
      observability_try_acquire_ticker_lease: {
        Args: { _name: string; _owner: string; _ttl_seconds?: number }
        Returns: boolean
      }
      offboard_workspace_member: {
        Args: {
          _actor_id: string
          _reason?: string
          _user_id: string
          _workspace_id: string
        }
        Returns: Json
      }
      patch_conversation_ai_memory: {
        Args: {
          p_conversation_id: string
          p_expected_rev: number
          p_memory: Json
          p_workspace_id: string
        }
        Returns: Json
      }
      patch_conversation_metadata: {
        Args: {
          p_conversation_id: string
          p_patch: Json
          p_workspace_id: string
        }
        Returns: Json
      }
      perf_metrics_rollup_and_prune: { Args: never; Returns: Json }
      phone_status_matches: {
        Args: { _filter: string; _phone: string; _verified_at: string }
        Returns: boolean
      }
      phone_verification_admin_resend_requested: {
        Args: {
          _admin_id: string
          _challenge_id: string
          _phone_masked: string
          _user_id: string
        }
        Returns: Json
      }
      phone_verification_cancel: {
        Args: {
          _actor_user_id?: string
          _challenge_id?: string
          _purpose?: string
          _user_id: string
          _workspace_id?: string
        }
        Returns: Json
      }
      phone_verification_claim_attempt: {
        Args: { _challenge_id: string; _user_id: string }
        Returns: Json
      }
      phone_verification_consume: {
        Args: { _challenge_id: string; _user_id: string }
        Returns: Json
      }
      phone_verification_finalize_admin_resend: {
        Args: {
          _admin_id: string
          _challenge_id: string
          _error_code?: string
          _provider_message_id?: string
          _provider_name?: string
          _sent: boolean
        }
        Returns: Json
      }
      phone_verification_invalidate: {
        Args: { _challenge_id: string }
        Returns: Json
      }
      phone_verification_manual_verify: {
        Args: { _admin_id: string; _reason: string; _user_id: string }
        Returns: Json
      }
      phone_verification_mark_delivery: {
        Args: {
          _challenge_id: string
          _provider_message_id?: string
          _provider_name?: string
          _sent: boolean
        }
        Returns: Json
      }
      phone_verification_start: {
        Args: {
          _challenge_id: string
          _code_digest: string
          _created_by: string
          _created_by_admin_id: string
          _created_ip_hash: string
          _max_attempts: number
          _phone: string
          _purpose: string
          _ttl_seconds: number
          _user_id: string
        }
        Returns: Json
      }
      phone_verification_state: { Args: { _user_id: string }; Returns: Json }
      phone_verification_verify: {
        Args: {
          _actor_user_id?: string
          _candidate_digest: string
          _challenge_id: string
          _purpose?: string
          _user_id: string
          _workspace_id?: string
        }
        Returns: Json
      }
      provision_account_on_signup: {
        Args: { _user_id: string }
        Returns: undefined
      }
      realtime_metrics_rollup_and_prune: { Args: never; Returns: Json }
      reclaim_expired_invitation_jobs: { Args: never; Returns: number }
      redeem_email_verify_token: {
        Args: { _token_hash: string }
        Returns: {
          redeemed_email: string
          redeemed_user_id: string
        }[]
      }
      redeem_password_reset_token: {
        Args: { _new_password_hash: string; _token_hash: string }
        Returns: {
          redeemed_email: string
          redeemed_sessions_revoked: number
          redeemed_user_id: string
        }[]
      }
      register_workspace_domain: {
        Args: {
          _make_primary?: boolean
          _raw_domain: string
          _workspace_id: string
        }
        Returns: undefined
      }
      release_channel_provider_account: {
        Args: { _integration_id: string }
        Returns: undefined
      }
      resend_invitation_email_v2: {
        Args: {
          _actor_id: string
          _destination_hash: string
          _invitation_id: string
          _job_idempotency_key: string
        }
        Returns: Json
      }
      resolve_privacy_subject: {
        Args: {
          _subject_id: string
          _subject_type: string
          _workspace_id: string
        }
        Returns: Json
      }
      revoke_invitation_v2: {
        Args: { _actor_id: string; _invitation_id: string; _reason: string }
        Returns: Json
      }
      rotate_manual_link_v2: {
        Args: {
          _actor_id: string
          _invitation_id: string
          _token_expires_at: string
          _token_hash: string
          _token_prefix: string
        }
        Returns: Json
      }
      set_workspace_seat_entitlement_mode: {
        Args: {
          _mode: string
          _seat_limit?: number
          _source: string
          _updated_by?: string
        }
        Returns: Json
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      sla_reliability_rollup_and_prune: { Args: never; Returns: Json }
      user_phone_verified: { Args: { _user_id: string }; Returns: boolean }
      wi_account_exists: {
        Args: { _email_normalized: string }
        Returns: boolean
      }
      wi_apply_departments: {
        Args: {
          _invitation_id: string
          _user_id: string
          _workspace_id: string
        }
        Returns: undefined
      }
      wi_assert_seat_available: {
        Args: { _workspace_id: string }
        Returns: Json
      }
      wi_audit: {
        Args: {
          _action: string
          _actor_id: string
          _entity_id: string
          _entity_type?: string
          _payload: Json
          _workspace_id: string
        }
        Returns: undefined
      }
      wi_can_manage_invitation: {
        Args: {
          _actor_role: Database["public"]["Enums"]["workspace_role"]
          _target_role: Database["public"]["Enums"]["workspace_role"]
        }
        Returns: boolean
      }
      wi_complete_invitation_job: {
        Args: {
          _claim_token: string
          _error_code?: string
          _job_id: string
          _outcome: string
          _provider_message_id?: string
          _provider_name?: string
          _retry_in_seconds?: number
          _safe_error_message?: string
        }
        Returns: Json
      }
      wi_consume_login_context: {
        Args: { _handle_hash: string }
        Returns: Json
      }
      wi_create_login_context: {
        Args: {
          _expires_at: string
          _handle_hash: string
          _purpose: string
          _token_hash: string
        }
        Returns: Json
      }
      wi_execute_idempotent: {
        Args: {
          _actor_id: string
          _args: Json
          _fingerprint: string
          _invitation_id: string
          _key: string
          _operation: string
          _scope_kind: string
          _ttl_seconds?: number
          _workspace_id: string
        }
        Returns: Json
      }
      wi_expire_due: { Args: { _workspace_id: string }; Returns: number }
      wi_fail_otp_job_atomic: {
        Args: {
          _claim_token: string
          _error_code?: string
          _job_id: string
          _outcome: string
          _provider_name?: string
          _safe_error_message?: string
          _worker_id: string
        }
        Returns: Json
      }
      wi_heartbeat_invitation_job: {
        Args: { _claim_token: string; _job_id: string; _lease_seconds?: number }
        Returns: boolean
      }
      wi_invitation_public_context: {
        Args: { _invitation_id: string }
        Returns: Json
      }
      wi_job_still_sendable: {
        Args: { _claim_token: string; _job_id: string }
        Returns: boolean
      }
      wi_lock_and_validate_token: {
        Args: { _purpose: string; _token_hash: string }
        Returns: Record<string, unknown>
      }
      wi_mask_email: { Args: { _email: string }; Returns: string }
      wi_mask_phone: { Args: { _phone: string }; Returns: string }
      wi_otp_digest_key_version: { Args: { _digest: string }; Returns: number }
      wi_otp_job_sendable: {
        Args: { _claim_token: string; _job_id: string }
        Returns: Json
      }
      wi_otp_pending_key_version: {
        Args: { _token_hash: string }
        Returns: number
      }
      wi_peek_idempotent: {
        Args: {
          _fingerprint: string
          _key: string
          _operation: string
          _scope_kind: string
        }
        Returns: Json
      }
      wi_prepare_invitation_job: {
        Args: {
          _claim_token: string
          _derivation_key_version?: number
          _job_id: string
          _token_expires_at?: string
          _token_hash?: string
          _token_prefix?: string
        }
        Returns: Json
      }
      wi_preview_invitation: {
        Args: { _purpose: string; _token_hash: string }
        Returns: Json
      }
      wi_preview_login_context: {
        Args: { _handle_hash: string }
        Returns: Json
      }
      wi_purge_expired_idempotency: {
        Args: { _limit?: number }
        Returns: number
      }
      wi_request_invitation_otp: {
        Args: {
          _code_digest: string
          _cooldown_seconds?: number
          _expires_at: string
          _ip_hash?: string
          _max_per_window?: number
          _token_hash: string
          _window_seconds?: number
        }
        Returns: Json
      }
      wi_request_invitation_otp_v2: {
        Args: {
          _code_digest: string
          _expires_at: string
          _ip_hash?: string
          _job_idempotency_key: string
          _otp_id: string
          _token_hash: string
        }
        Returns: Json
      }
      wi_resolve_seat_capacity: {
        Args: { _workspace_id: string }
        Returns: {
          limit_value: number
          source: string
          used: number
          version: number
        }[]
      }
      wi_revoke_login_context: {
        Args: { _handle_hash: string }
        Returns: undefined
      }
      wi_revoke_secrets: {
        Args: {
          _generation?: number
          _invitation_id: string
          _purpose?: string
        }
        Returns: undefined
      }
      wi_revoke_undelivered_otp: { Args: { _job_id: string }; Returns: boolean }
      wi_safe_invitation: { Args: { _invitation_id: string }; Returns: Json }
      wi_set_invitation_locale: {
        Args: { _invitation_id: string; _locale: string }
        Returns: Json
      }
      wi_verify_invitation_otp: {
        Args: {
          _code_digest: string
          _proof_expires_at: string
          _proof_hash: string
          _token_hash: string
        }
        Returns: Json
      }
      workspace_health_snapshot_compute: { Args: never; Returns: Json }
      workspace_owner_phone_verified: {
        Args: { _workspace_id: string }
        Returns: boolean
      }
    }
    Enums: {
      ai_kb_generated_status: "pending" | "accepted" | "rejected" | "published"
      ai_kb_job_status:
        | "queued"
        | "running"
        | "crawling"
        | "extracting"
        | "generating"
        | "completed"
        | "partial"
        | "failed"
        | "canceled"
      ai_kb_page_status:
        | "pending"
        | "fetched"
        | "extracted"
        | "skipped"
        | "failed"
      ai_kb_source_kind: "workspace_domain" | "profile_domain"
      app_role: "admin" | "moderator" | "user"
      article_status: "draft" | "published" | "archived"
      call_context_type: "conversation" | "internal" | "verification"
      call_invitation_channel: "audio" | "video"
      call_invitation_status:
        | "pending"
        | "joined"
        | "expired"
        | "cancelled"
        | "declined"
      call_participant_type: "visitor" | "operator" | "admin" | "internal"
      call_queue_channel: "audio" | "video"
      call_queue_state:
        | "queued"
        | "offered"
        | "accepted"
        | "cancelled"
        | "expired"
        | "missed"
        | "callback_requested"
      call_recording_state:
        | "disabled"
        | "pending"
        | "recording"
        | "finalizing"
        | "available"
        | "failed"
      call_state:
        | "pending"
        | "ringing"
        | "connecting"
        | "active"
        | "ended"
        | "failed"
        | "cancelled"
        | "missed"
      call_type: "audio" | "video" | "screenshare" | "meeting"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
      ai_kb_generated_status: ["pending", "accepted", "rejected", "published"],
      ai_kb_job_status: [
        "queued",
        "running",
        "crawling",
        "extracting",
        "generating",
        "completed",
        "partial",
        "failed",
        "canceled",
      ],
      ai_kb_page_status: [
        "pending",
        "fetched",
        "extracted",
        "skipped",
        "failed",
      ],
      ai_kb_source_kind: ["workspace_domain", "profile_domain"],
      app_role: ["admin", "moderator", "user"],
      article_status: ["draft", "published", "archived"],
      call_context_type: ["conversation", "internal", "verification"],
      call_invitation_channel: ["audio", "video"],
      call_invitation_status: [
        "pending",
        "joined",
        "expired",
        "cancelled",
        "declined",
      ],
      call_participant_type: ["visitor", "operator", "admin", "internal"],
      call_queue_channel: ["audio", "video"],
      call_queue_state: [
        "queued",
        "offered",
        "accepted",
        "cancelled",
        "expired",
        "missed",
        "callback_requested",
      ],
      call_recording_state: [
        "disabled",
        "pending",
        "recording",
        "finalizing",
        "available",
        "failed",
      ],
      call_state: [
        "pending",
        "ringing",
        "connecting",
        "active",
        "ended",
        "failed",
        "cancelled",
        "missed",
      ],
      call_type: ["audio", "video", "screenshare", "meeting"],
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
