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
          handoff_prechat_message_localized: Json
          handoff_when_no_kb_match: boolean
          id: string
          instructions: Json
          intro_message: string | null
          intro_message_localized: Json
          keep_in_automated_until_handoff: boolean
          learning_enabled: boolean
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
          handoff_prechat_message_localized?: Json
          handoff_when_no_kb_match?: boolean
          id?: string
          instructions?: Json
          intro_message?: string | null
          intro_message_localized?: Json
          keep_in_automated_until_handoff?: boolean
          learning_enabled?: boolean
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
          handoff_prechat_message_localized?: Json
          handoff_when_no_kb_match?: boolean
          id?: string
          instructions?: Json
          intro_message?: string | null
          intro_message_localized?: Json
          keep_in_automated_until_handoff?: boolean
          learning_enabled?: boolean
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
          body: string
          created_at: string
          id: string
          read_at: string | null
          recipient_id: string
          sender_id: string
          workspace_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          read_at?: string | null
          recipient_id: string
          sender_id: string
          workspace_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          read_at?: string | null
          recipient_id?: string
          sender_id?: string
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
        Relationships: []
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
          assignment_mode: string
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
          round_robin_cursor_user_id: string | null
          secondary_color: string | null
          show_logo: boolean | null
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
          round_robin_cursor_user_id?: string | null
          secondary_color?: string | null
          show_logo?: boolean | null
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
          round_robin_cursor_user_id?: string | null
          secondary_color?: string | null
          show_logo?: boolean | null
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
      admin_count_profiles:
        | { Args: never; Returns: number }
        | {
            Args: { _phone_status?: string; _search?: string }
            Returns: number
          }
      admin_count_workspaces:
        | { Args: never; Returns: number }
        | {
            Args: { _phone_status?: string; _search?: string }
            Returns: number
          }
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
      admin_list_profiles:
        | {
            Args: {
              _limit?: number
              _offset?: number
              _search?: string
              _sort?: string
            }
            Returns: Json
          }
        | {
            Args: {
              _limit?: number
              _offset?: number
              _phone_status?: string
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
        | {
            Args: {
              _limit?: number
              _offset?: number
              _phone_status?: string
              _search?: string
              _sort?: string
            }
            Returns: Json
          }
      admin_security_stats: { Args: never; Returns: Json }
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
      bootstrap_admin: { Args: { _user_id: string }; Returns: boolean }
      bulk_create_contacts: {
        Args: { _contacts: Json; _workspace_id: string }
        Returns: {
          inserted: number
        }[]
      }
      business_metrics_rollup_and_prune: { Args: never; Returns: Json }
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
      enqueue_entitlement_fanout: {
        Args: { _plan_id?: string; _scope: string; _source: string }
        Returns: string
      }
      enqueue_kb_catchup: { Args: { _workspace_id: string }; Returns: number }
      evaluate_alert_rules: { Args: never; Returns: Json }
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
      sla_reliability_rollup_and_prune: { Args: never; Returns: Json }
      user_phone_verified: { Args: { _user_id: string }; Returns: boolean }
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
