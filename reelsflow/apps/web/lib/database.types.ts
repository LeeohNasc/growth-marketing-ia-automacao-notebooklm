/**
 * Tipos do schema público. Escritos à mão na Fase 1 a partir de
 * supabase/migrations; substituir por `supabase gen types typescript` assim que
 * houver projeto Supabase vinculado (pendência registrada no README).
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type WorkspaceRole = "viewer" | "editor" | "admin" | "owner";
export type MediaStatus = "uploading" | "uploaded" | "processing" | "ready" | "failed";

export type CardRenderStatus = "draft" | "rendering" | "processing" | "ready" | "error";
export type EditorialCardRow = {
  id: string; workspace_id: string; created_by: string | null; template_type: "editorial_card"; template_version: number;
  title: string; page_name: string; username: string; headline: string; caption: string | null; hashtags: string[];
  format: "feed" | "square" | "vertical"; media_kind: "image" | "image_pair" | "video"; fit: "cover" | "contain";
  style: Json; focal: Json; avatar_path: string | null; media_paths: string[]; media_meta: Json; social_account_id: string | null;
  render_status: CardRenderStatus; render_error: string | null; rendered_media_id: string | null;
  render_started_at: string | null; rendered_at: string | null; created_at: string; updated_at: string;
};
export type EditorialCardUpdate = Partial<Pick<EditorialCardRow,
  "title" | "page_name" | "username" | "headline" | "caption" | "hashtags" | "format" | "media_kind" | "fit" | "style" | "focal" |
  "avatar_path" | "media_paths" | "media_meta" | "social_account_id">>;

export type MediaAssetRow = {
  id: string;
  workspace_id: string;
  uploaded_by: string | null;
  name: string;
  original_filename: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  status: MediaStatus;
  failure_reason: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  rotation: number | null;
  fps: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  has_audio: boolean | null;
  bitrate: number | null;
  container: string | null;
  thumbnail_path: string | null;
  compatibility: Json;
  probed_at: string | null;
  default_caption: string | null;
  default_hashtags: string[];
  upload_expires_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  /** Gerado pelo banco a partir do MIME: video | image. */
  kind: "video" | "image";
  /** Card Editorial que gerou este arquivo final (se houver). */
  source_card_id: string | null;
};

type Timestamps = { created_at: string };

export type SocialPlatform = "instagram" | "facebook" | "tiktok" | "youtube" | "mock";
export type CampaignStatus = "draft" | "active" | "paused" | "completed" | "archived";
export type JobStatusDb =
  | "draft" | "scheduled" | "queued" | "preparing" | "uploading" | "processing_remote" | "publishing"
  | "published" | "failed_retryable" | "failed_permanent" | "uncertain" | "needs_review" | "cancelled";

export type SocialAccountRow = {
  id: string; workspace_id: string; platform: SocialPlatform; external_account_id: string; display_name: string;
  avatar_url: string | null; status: "active" | "needs_reauth" | "disconnected"; paused: boolean; min_spacing_minutes: number;
  settings: Json; connected_by: string | null; token_expires_at: string | null; created_at: string; updated_at: string;
  /** native = conexão direta; zernio = publicada pela Zernio (external_account_id = id da conta na Zernio). */
  provider: "native" | "zernio"; provider_profile_id: string | null;
};
export type TemplateRow = {
  id: string; workspace_id: string; name: string; mode: "mirrored" | "independent"; timezone: string; weekdays: number[]; times: string[];
  caption: string | null; hashtags: string[]; order_strategy: string; max_lateness_minutes: number; created_by: string | null;
  created_at: string; updated_at: string;
};
export type CampaignRow = {
  id: string; workspace_id: string; template_id: string | null; source_collection_id: string | null; name: string; status: CampaignStatus;
  mode: "mirrored" | "independent"; timezone: string; weekdays: number[]; times: string[]; start_date: string; end_date: string | null;
  order_strategy: string; random_seed: number; caption: string | null; hashtags: string[]; max_lateness_minutes: number;
  activated_at: string | null; completed_at: string | null; summary: Json | null; created_by: string | null; created_at: string; updated_at: string;
};
export type CampaignTargetRow = {
  id: string; campaign_id: string; workspace_id: string; social_account_id: string; offset_minutes: number; weekdays: number[] | null;
  times: string[] | null; caption_override: string | null; hashtags_override: string[] | null; enabled: boolean; created_at: string;
};
export type CampaignMediaRow = {
  id: string; campaign_id: string; workspace_id: string; media_asset_id: string; target_id: string | null; position: number;
  caption_override: string | null; hashtags_override: string[] | null; added_at: string;
};
export type PublicationJobRow = {
  id: string; workspace_id: string; campaign_id: string | null; campaign_media_id: string | null; target_id: string | null;
  social_account_id: string | null; media_asset_id: string | null; post_group_key: string | null; local_date: string; local_time: string;
  timezone: string; scheduled_at: string; dst_adjusted: boolean; status: JobStatusDb; caption_override: string | null; effective_config: Json | null;
  attempt_count: number; max_attempts: number; next_attempt_at: string; lease_owner: string | null; lease_expires_at: string | null;
  external_checkpoint: Json | null; reconcile_attempts: number; last_error_class: string | null; last_error_message: string | null;
  review_reason: string | null; pinned: boolean; published_at: string | null; created_at: string; updated_at: string;
};
type ReadOnly<R> = { Row: R; Insert: never; Update: never; Relationships: [] };

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: { id: string; display_name: string; locale: string; default_timezone: string; updated_at: string } & Timestamps;
        Insert: never;
        Update: { display_name?: string; locale?: string; default_timezone?: string };
        Relationships: [];
      };
      workspaces: {
        Row: {
          id: string;
          name: string;
          slug: string;
          created_by: string | null;
          default_timezone: string;
          is_demo: boolean;
          queue_paused: boolean;
          settings: Json;
          updated_at: string;
        } & Timestamps;
        Insert: never;
        Update: { name?: string; default_timezone?: string; queue_paused?: boolean; settings?: Json };
        Relationships: [];
      };
      workspace_members: {
        Row: { workspace_id: string; user_id: string; role: WorkspaceRole } & Timestamps;
        Insert: { workspace_id: string; user_id: string; role?: WorkspaceRole };
        Update: { role?: WorkspaceRole };
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      subscriptions: {
        Row: {
          workspace_id: string;
          plan: "starter" | "pro" | "agency";
          status: "active" | "past_due" | "canceled";
          limits: Json;
          provider_ref: string | null;
          updated_at: string;
        } & Timestamps;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      usage_records: {
        Row: { id: number; workspace_id: string; metric: string; quantity: number; period_start: string; updated_at: string };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      notification_preferences: {
        Row: { user_id: string; workspace_id: string; email_enabled: boolean; muted_types: string[]; updated_at: string };
        Insert: { user_id: string; workspace_id: string; email_enabled?: boolean; muted_types?: string[] };
        Update: { email_enabled?: boolean; muted_types?: string[] };
        Relationships: [];
      };
      notifications: {
        Row: {
          id: string;
          workspace_id: string;
          user_id: string;
          type: string;
          payload: Json;
          read_at: string | null;
          email_status: string | null;
          email_error?: string | null;
          emailed_at?: string | null;
        } & Timestamps;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      editorial_cards: {
        Row: EditorialCardRow;
        Insert: Pick<EditorialCardRow, "workspace_id" | "created_by" | "title"> & EditorialCardUpdate & { template_version?: number };
        Update: EditorialCardUpdate;
        Relationships: [];
      };
      media_assets: {
        Row: MediaAssetRow;
        Insert: never;
        Update: { name?: string; default_caption?: string | null; default_hashtags?: string[] };
        Relationships: [];
      };
      collections: {
        Row: { id: string; workspace_id: string; name: string; created_by: string | null; created_at: string; updated_at: string };
        Insert: { workspace_id: string; name: string; created_by: string };
        Update: { name?: string };
        Relationships: [];
      };
      collection_items: {
        Row: { collection_id: string; media_asset_id: string; workspace_id: string; position: number; added_at: string };
        Insert: { collection_id: string; media_asset_id: string; workspace_id: string; position?: number };
        Update: never;
        Relationships: [];
      };
      social_accounts: {
        Row: SocialAccountRow;
        Insert: never;
        Update: { display_name?: string; paused?: boolean; min_spacing_minutes?: number; settings?: Json };
        Relationships: [];
      };
      publication_templates: {
        Row: TemplateRow;
        Insert: Omit<TemplateRow, "id" | "created_at" | "updated_at" | "hashtags" | "caption" | "order_strategy" | "max_lateness_minutes" | "mode"> &
          Partial<Pick<TemplateRow, "hashtags" | "caption" | "order_strategy" | "max_lateness_minutes" | "mode">>;
        Update: Partial<Pick<TemplateRow, "name" | "mode" | "timezone" | "weekdays" | "times" | "caption" | "hashtags" | "order_strategy" | "max_lateness_minutes">>;
        Relationships: [];
      };
      campaigns: {
        Row: CampaignRow;
        Insert: Pick<CampaignRow, "workspace_id" | "name" | "timezone" | "weekdays" | "times" | "start_date" | "created_by"> &
          Partial<Pick<CampaignRow, "template_id" | "source_collection_id" | "mode" | "end_date" | "order_strategy" | "caption" | "hashtags" | "max_lateness_minutes">>;
        Update: Partial<Pick<CampaignRow, "template_id" | "source_collection_id" | "name" | "mode" | "timezone" | "weekdays" | "times" | "start_date" | "end_date" | "order_strategy" | "random_seed" | "caption" | "hashtags" | "max_lateness_minutes">>;
        Relationships: [];
      };
      campaign_targets: {
        Row: CampaignTargetRow;
        Insert: Pick<CampaignTargetRow, "campaign_id" | "workspace_id" | "social_account_id"> & Partial<Pick<CampaignTargetRow, "offset_minutes" | "weekdays" | "times" | "caption_override" | "hashtags_override" | "enabled">>;
        Update: Partial<Pick<CampaignTargetRow, "offset_minutes" | "weekdays" | "times" | "caption_override" | "hashtags_override" | "enabled">>;
        Relationships: [];
      };
      campaign_media: {
        Row: CampaignMediaRow;
        Insert: Pick<CampaignMediaRow, "campaign_id" | "workspace_id" | "media_asset_id"> & Partial<Pick<CampaignMediaRow, "target_id" | "position" | "caption_override" | "hashtags_override">>;
        Update: Partial<Pick<CampaignMediaRow, "position" | "caption_override" | "hashtags_override">>;
        Relationships: [];
      };
      publication_jobs: ReadOnly<PublicationJobRow>;
      publication_attempts: ReadOnly<{
        id: number; job_id: string; workspace_id: string; attempt_no: number; worker_id: string; kind: "publish" | "reconcile";
        started_at: string; finished_at: string | null; phase_reached: string | null; outcome: string | null; error_class: string | null;
        error_code: string | null; error_message: string | null; retry_after_seconds: number | null; checkpoint: Json | null;
      }>;
      external_publications: ReadOnly<{
        id: string; job_id: string; workspace_id: string; social_account_id: string | null; platform: SocialPlatform; external_id: string | null;
        permalink: string | null; published_at: string; source: "api" | "reconciled" | "manual"; created_at: string;
      }>;
      social_account_capabilities: ReadOnly<{ social_account_id: string; workspace_id: string; capability: string; granted: boolean; details: Json; checked_at: string }>;
      workspace_invitations: ReadOnly<{
        id: string; workspace_id: string; email: string; role: WorkspaceRole; invited_by: string | null; created_at: string;
        expires_at: string; accepted_at: string | null; revoked_at: string | null;
      }>;
      automation_rules: ReadOnly<{ workspace_id: string; rule_key: string; enabled: boolean; params: Json; updated_by: string | null; updated_at: string }>;
      automation_runs: ReadOnly<{
        id: number; workspace_id: string; rule_key: string; subject_type: string; subject_id: string | null; outcome: string; details: Json; dedupe_key: string | null; created_at: string;
      }>;
      audit_logs: {
        Row: {
          id: number;
          workspace_id: string | null;
          actor_id: string | null;
          action: string;
          entity: string;
          entity_id: string | null;
          diff: Json;
        } & Timestamps;
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      set_card_render_state: { Args: { p_card: string; p_state: "rendering" | "error" | "draft"; p_error?: string | null }; Returns: CardRenderStatus };
      attach_card_render: { Args: { p_card: string; p_media: string }; Returns: CardRenderStatus };
      duplicate_editorial_card: { Args: { p_card: string }; Returns: string };
      delete_editorial_card: { Args: { p_card: string }; Returns: undefined };
      create_workspace: {
        Args: { p_name: string; p_timezone: string };
        Returns: Database["public"]["Tables"]["workspaces"]["Row"];
      };
      mark_notifications_read: { Args: { p_ids: string[] }; Returns: number };
      begin_media_upload: {
        Args: { p_workspace: string; p_files: Json };
        Returns: { media_id: string; storage_path: string; original_filename: string }[];
      };
      complete_media_upload: { Args: { p_media: string }; Returns: MediaStatus };
      cancel_media_upload: { Args: { p_media: string }; Returns: undefined };
      delete_media: { Args: { p_ids: string[] }; Returns: number };
      restore_media: { Args: { p_ids: string[] }; Returns: number };
      retry_media_processing: { Args: { p_ids: string[] }; Returns: number };
      reorder_collection: { Args: { p_collection: string; p_media: string[] }; Returns: undefined };
      create_simulated_account: { Args: { p_workspace: string; p_name: string; p_behavior?: string }; Returns: SocialAccountRow };
      delete_social_account: { Args: { p_account: string }; Returns: undefined };
      save_campaign_plan: { Args: { p_campaign: string; p_jobs: Json; p_replace?: boolean }; Returns: { inserted: number; skipped_duplicates: number; removed: number }[] };
      set_campaign_status: { Args: { p_campaign: string; p_action: string }; Returns: CampaignStatus };
      cancel_jobs: { Args: { p_ids: string[] }; Returns: number };
      reschedule_job: { Args: { p_job: string; p_at: string }; Returns: undefined };
      update_job_caption: { Args: { p_job: string; p_caption: string }; Returns: undefined };
      confirm_job_published: { Args: { p_job: string; p_permalink?: string }; Returns: undefined };
      begin_oauth: { Args: { p_workspace: string; p_provider: string }; Returns: string };
      check_oauth_state: { Args: { p_state: string }; Returns: boolean };
      complete_oauth: { Args: { p_state: string; p_pending: Json }; Returns: string };
      connect_instagram_account: { Args: { p_state: string; p_account: Json }; Returns: string };
      get_oauth_pending: { Args: { p_state: string }; Returns: Json };
      finalize_oauth: { Args: { p_state: string; p_keys: string[] }; Returns: number };
      disconnect_social_account: { Args: { p_account: string }; Returns: undefined };
      meta_data_deletion: { Args: { p_meta_user_id: string }; Returns: string };
      data_deletion_status: { Args: { p_code: string }; Returns: { status: string; accounts_removed: number; created_at: string; completed_at: string | null }[] };
      workspace_usage: { Args: { p_workspace: string }; Returns: Json };
      create_invitation: { Args: { p_workspace: string; p_email: string; p_role: WorkspaceRole }; Returns: string };
      accept_invitation: { Args: { p_token: string }; Returns: string };
      revoke_invitation: { Args: { p_id: string }; Returns: undefined };
      invitation_preview: { Args: { p_token: string }; Returns: { workspace_name: string; role: WorkspaceRole; email: string; valid: boolean }[] };
      publication_analytics: { Args: { p_workspace: string; p_from: string; p_to: string }; Returns: Json };
      worker_last_seen: { Args: Record<string, never>; Returns: string | null };
      set_automation_rule: { Args: { p_workspace: string; p_rule: string; p_enabled: boolean; p_params?: Json }; Returns: undefined };
      account_deletion_blockers: {
        Args: Record<string, never>;
        Returns: { workspace_id: string; workspace_name: string; other_members: number }[];
      };
    };
    Enums: { workspace_role: WorkspaceRole; media_status: MediaStatus; card_render_status: CardRenderStatus; social_platform: SocialPlatform; campaign_status: CampaignStatus; job_status: JobStatusDb };
    CompositeTypes: Record<string, never>;
  };
};
