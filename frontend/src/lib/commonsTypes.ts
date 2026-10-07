export type Role = 'attract' | 'avoid' | 'evidence' | 'neutral';
export const ROLES: Role[] = ['attract', 'avoid', 'evidence', 'neutral'];
export type AnalysisState = 'held' | 'queued' | 'analyzing' | 'analysis_failed' | 'ready';
export const AXES = ['quiet_loud', 'warm_cold', 'geometric_humanist', 'dense_airy', 'polished_raw'] as const;
export type Axis = (typeof AXES)[number];
export const AXIS_LABELS: Record<Axis, [string, string]> = {
  quiet_loud: ['Quiet', 'Loud'], warm_cold: ['Warm', 'Cold'], geometric_humanist: ['Geometric', 'Humanist'],
  dense_airy: ['Dense', 'Airy'], polished_raw: ['Polished', 'Raw'],
};
export const ENUMS = {
  type_style: ['geometric_sans', 'humanist_sans', 'serif', 'mono', 'script', 'display', 'none'],
  spacing_density: ['tight', 'balanced', 'airy'],
  layout: ['grid', 'modular', 'freeform', 'centered', 'asymmetric', 'n_a'],
  medium: ['photo', 'render', 'illustration', 'ui', 'type_specimen', 'object', 'space', 'motion_still'],
} as const;
export type EnumField = keyof typeof ENUMS;
export const TEXT_FIELDS = ['summary', 'subject', 'composition_notes'] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

export interface SearchRow {
  id: string; membership_id: string; collection_id: string; collection: string; summary: string | null;
  role: Role; media: 'image' | 'video'; made_by: string; analysis_state: AnalysisState; in_inbox: boolean;
  comment_count: number; matched: string[]; score: number; blob_key: string; also_in: string[];
}
export interface PaletteEntry { index?: number; hex: string; share: number; is_accent: boolean }
export interface Region { id: string; box: [number, number, number, number]; label: string; note: string | null;
  status: 'proposed' | 'confirmed' | 'deleted'; actor: string }
export interface Comment { id: string; actor: string; text: string; created_at: string; source_date: string | null; region: string | null }
export interface Sighting { id: string; source_kind: string; url: string | null; page_url: string | null;
  page_title: string | null; original_path?: string | null; original_name: string | null; source_date: string | null;
  state: 'ok' | 'missing_from_folder' | 'archived' | 'superseded' }
export interface MembershipDetail { id: string; collection: string; collection_name: string; brand: string | null;
  role: Role; why: string | null; actor: string; in_inbox: number; sightings: Sighting[]; comments: Comment[] }
export interface Borrowing { id: string; attribute: string; value: unknown; used_in: { kind: string; ref: string };
  why: string; actor: string; fidelity: { status: string; reason?: string } | null; created_at: string }

/** A model-read field: the value plus the model's reason. Corrections may leave `why` absent. */
export interface ReadField<T> { value: T; why?: string }
/** Effective fields = code measurements + model reading + corrections (§6.4). Every key may be absent. */
export interface EffectiveFields {
  palette?: PaletteEntry[];
  value_range?: { low: number; high: number };
  aspect?: number;
  duration?: number;
  cuts_per_min?: number;
  summary?: ReadField<string>;
  subject?: ReadField<string>;
  composition_notes?: ReadField<string>;
  type_style?: ReadField<string>;
  spacing_density?: ReadField<string>;
  layout?: ReadField<string>;
  medium?: ReadField<string>;
  axes?: Partial<Record<Axis, ReadField<number>>>;
  keywords?: string[];
  [key: string]: unknown;
}
export interface AssetDetail {
  asset: { id: string; media: 'image' | 'video'; width: number | null; height: number | null; made_by: string;
    analysis_state: AnalysisState; last_error: string | null; measurements: Record<string, unknown> | null };
  effective: { fields: EffectiveFields; sources: Record<string, string>; corrected_paths: string[];
    analysis: { model_id: string; prompt_version: string; created_at: string } | null };
  corrections: { id: string; field_path: string; op: string; value: unknown; actor: string; reason: string | null; at: string }[];
  regions: Region[]; memberships: MembershipDetail[]; borrowings: Borrowing[]; quarantined?: boolean;
  blob_url: string; keyframes?: { t: number; asset_id: string; blob_url: string }[];
}
export interface Collection { id: string; name: string; kind: string; brand: string | null; folder_link: string | null }
export interface MeterReading { calls: number; cap: number; remaining: number; resets_at: string }
export interface CommonsStatus {
  evaluation_waiting?: boolean;
  evaluation_state?: 'none' | 'open' | 'sealed' | 'closed';
  evaluation_assisted?: boolean;
  worker: { state: string; running: boolean; budget_used: number; budget: number | null };
  meter: MeterReading; agent_adds?: MeterReading;
  queue: Record<AnalysisState, number>; load: number; load_threshold: number;
}
export interface FolderLink { id: string; path: string; ignores: string[]; last_scan_at: string | null;
  last_scan_summary: Record<string, unknown> | null; device_states: { path: string; state: string; error: string | null }[] }

export interface FilterState {
  query: string; axes: Partial<Record<Axis, [number, number]>>; keywords: string[];
  paletteHex: string; paletteDeltaE: number; collection: string; media: '' | 'image' | 'video';
  role: '' | Role; madeBy: '' | 'human' | 'ai' | 'unknown'; correctedOnly: boolean; hasComments: boolean; inbox: boolean;
}
export const EMPTY_FILTERS: FilterState = {
  query: '', axes: {}, keywords: [], paletteHex: '', paletteDeltaE: 10, collection: '', media: '', role: '',
  madeBy: '', correctedOnly: false, hasComments: false, inbox: false,
};
