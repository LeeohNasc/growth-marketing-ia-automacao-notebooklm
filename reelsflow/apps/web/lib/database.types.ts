/**
 * Tipos do schema público. Escritos à mão na Fase 1 a partir de
 * supabase/migrations; substituir por `supabase gen types typescript` assim que
 * houver projeto Supabase vinculado (pendência registrada no README).
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type WorkspaceRole = "viewer" | "editor" | "admin" | "owner";
export type MediaStatus = "uploading" | "uploaded" | "processing" | "ready" | "failed";

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
};

type Timestamps = { created_at: string };

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
      notifications: {
        Row: {
          id: string;
          workspace_id: string;
          user_id: string;
          type: string;
          payload: Json;
          read_at: string | null;
          email_status: string | null;
        } & Timestamps;
        Insert: never;
        Update: never;
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
      account_deletion_blockers: {
        Args: Record<string, never>;
        Returns: { workspace_id: string; workspace_name: string; other_members: number }[];
      };
    };
    Enums: { workspace_role: WorkspaceRole; media_status: MediaStatus };
    CompositeTypes: Record<string, never>;
  };
};
