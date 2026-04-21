/**
 * Settings Console types — feature-local backend contracts.
 *
 * Cross-feature types stay in `shared/types/common.ts`; everything in
 * here is consumed only by the Settings page.
 */

export type SettingType = "float" | "int" | "bool" | "str" | "enum";
export type Mutability = "hot_apply" | "warm_reload" | "restart_required" | "read_only";

export interface SettingSpec {
  key: string;
  default: number | string | boolean;
  type: SettingType;
  category: string;
  mutability: Mutability;
  description: string;
  min: number | null;
  max: number | null;
  step: number | null;
  enum: string[] | null;
  requires_privacy_confirm: boolean;
}

export interface SettingsSchema {
  schema_version: number;
  categories: string[];
  settings: SettingSpec[];
}

export interface EffectiveSettings {
  schema_version: number;
  values: Record<string, number | string | boolean>;
  revision_hash: string;
  revision_no: number;
}

export interface ApplyResultPayload {
  ok: boolean;
  applied_now: string[];
  pending_restart: string[];
  warnings: string[];
  revision_hash_before: string;
  revision_hash_after: string;
  revision_no: number;
  audit_id?: string | null;
}

export interface ValidationErrorBody {
  errors: Array<{ key: string; reason: string }>;
}

export type DraftValue = number | string | boolean;
