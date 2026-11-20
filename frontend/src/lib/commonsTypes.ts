export type Role = 'attract' | 'avoid' | 'evidence' | 'neutral';
export const ROLES: Role[] = ['attract', 'avoid', 'evidence', 'neutral'];
/** What a person reads for a role; the stored value stays the option's `value` (design: a person never reads an enum value). */
export const ROLE_LABELS: Record<Role, string> = {
  attract: 'Attract', avoid: 'Avoid', evidence: 'Evidence', neutral: 'Neutral',
};
/** A palette colour's role, as the reader and the evaluation batch send it (backend commons/reader.py ROLES). */
export type PaletteRole = 'background' | 'dominant' | 'accent' | 'text' | 'other';
export const PALETTE_ROLE_LABELS: Record<PaletteRole, string> = {
  background: 'Background', dominant: 'Dominant', accent: 'Accent', text: 'Text', other: 'Other',
};
/** What a person reads for a palette role; a role this app doesn't know reads as capitalised words. */
export function paletteRoleLabel(role: string | null | undefined): string {
  return ownLabel(PALETTE_ROLE_LABELS, role) ?? words(role);
}
/** Own-property lookup: 'constructor' or 'toString' is not a label. Null, undefined and '' find nothing. */
function ownLabel<V>(map: object, key: string | null | undefined): V | undefined {
  if (key == null || key === '' || !Object.hasOwn(map, key)) return undefined;
  return (map as Record<string, V>)[key];
}
/** Capitalised words from a stored key (underscores to spaces); '' for null, undefined or ''. */
function words(key: string | null | undefined): string {
  return key ? capitalised(key.replaceAll('_', ' ')) : '';
}
export type AnalysisState = 'held' | 'queued' | 'analyzing' | 'analysis_failed' | 'ready';
/** Capitalise the first letter: how an unknown value from an older or newer backend reads (as itself, not lower case). */
export function capitalised(value: string | null | undefined): string {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}
/** A sighting's source kind (backend commons/db.py CHECK on sightings.source_kind). */
export type SourceKind = 'file' | 'folder' | 'url' | 'moodboard' | 'agent' | 'keyframe' | 'output';
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  file: 'File', folder: 'Folder', url: 'Web', moodboard: 'Moodboard', agent: 'Agent', keyframe: 'Keyframe', output: 'Output',
};
/** What a person reads for a source kind; one the app doesn't know reads as itself, capitalised. */
export function sourceKindLabel(kind: string | null | undefined): string {
  return ownLabel<string>(SOURCE_KIND_LABELS, kind) ?? capitalised(kind);
}
/** A sighting's shown state ('ok' shows no badge). The class modifier stays the raw word; CSS keys on it. */
export const SIGHTING_STATE_LABELS: Record<'missing_from_folder' | 'archived' | 'superseded', string> = {
  missing_from_folder: 'Missing', archived: 'Archived', superseded: 'Superseded',
};
export type RegionStatus = 'proposed' | 'confirmed' | 'deleted';
export const REGION_STATUS_LABELS: Record<RegionStatus, string> = { proposed: 'Proposed', confirmed: 'Confirmed', deleted: 'Deleted' };
/** A region's status for a person; one the app doesn't know reads as capitalised words. */
export function regionStatusLabel(status: string | null | undefined): string {
  return ownLabel<string>(REGION_STATUS_LABELS, status) ?? words(status);
}
/** A borrowing's fidelity status (backend commons/borrow.py); 'pending' stands in when none is recorded yet. */
export type FidelityStatus = 'pending' | 'pass' | 'fail' | 'unverifiable';
export const FIDELITY_STATUS_LABELS: Record<FidelityStatus, string> = {
  pending: 'Pending', pass: 'Passed', fail: 'Failed', unverifiable: 'Unverifiable',
};
export function fidelityStatusLabel(status: string | null | undefined): string {
  return ownLabel<string>(FIDELITY_STATUS_LABELS, status) ?? capitalised(status);
}
/** A folder file's pending device state (backend commons/db.py). */
export type DeviceState = 'downloading' | 'download_failed';
export const DEVICE_STATE_LABELS: Record<DeviceState, string> = { downloading: 'Downloading', download_failed: 'Download failed' };
export function deviceStateLabel(state: string | null | undefined): string {
  return ownLabel<string>(DEVICE_STATE_LABELS, state) ?? words(state);
}
export type Media = 'image' | 'video';
export const MEDIA_LABELS: Record<Media, string> = { image: 'Image', video: 'Video' };
/** A media kind for a person; one the app doesn't know reads as capitalised words. */
export function mediaLabel(media: string | null | undefined): string {
  return ownLabel<string>(MEDIA_LABELS, media) ?? words(media);
}
export type MadeBy = 'human' | 'ai' | 'unknown';
/** The detail line's sentence for who made an asset; the filter's dropdown names the value ("Human", "AI") instead. */
export const MADE_BY_SENTENCES: Record<MadeBy, string> = {
  human: 'Made by a person', ai: 'Made by AI', unknown: 'Maker unknown',
};
export function madeBySentence(madeBy: string | null | undefined): string {
  if (!madeBy) return '';
  return ownLabel<string>(MADE_BY_SENTENCES, madeBy) ?? `Made by ${madeBy}`;
}
export const AXES = ['quiet_loud', 'warm_cold', 'geometric_humanist', 'dense_airy', 'polished_raw'] as const;
export type Axis = (typeof AXES)[number];
export const AXIS_LABELS: Record<Axis, [string, string]> = {
  quiet_loud: ['Quiet', 'Loud'], warm_cold: ['Warm', 'Cold'], geometric_humanist: ['Geometric', 'Humanist'],
  dense_airy: ['Dense', 'Airy'], polished_raw: ['Polished', 'Raw'],
};
/** An axis for a person, as the detail panel reads it ("Quiet – Loud"); an unknown key reads as capitalised words. */
export function axisLabel(key: string | null | undefined): string {
  const ends = ownLabel<[string, string]>(AXIS_LABELS, key);
  return ends ? ends.join(' – ') : words(key);
}
/** An axis value for a person: two decimals, a true minus (U+2212) for a negative, no sign on zero. */
export function axisValue(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '';
  const text = Math.abs(n).toFixed(2);
  return n < 0 && Number(text) !== 0 ? `\u2212${text}` : text;
}
export const ENUMS = {
  type_style: ['geometric_sans', 'humanist_sans', 'serif', 'mono', 'script', 'display', 'none'],
  spacing_density: ['tight', 'balanced', 'airy'],
  layout: ['grid', 'modular', 'freeform', 'centered', 'asymmetric', 'n_a'],
  medium: ['photo', 'render', 'illustration', 'ui', 'type_specimen', 'object', 'space', 'motion_still'],
} as const;
export type EnumField = keyof typeof ENUMS;
/** What a person reads for each enum value, typed over the value union so a new value without a label fails tsc. */
export const ENUM_VALUE_LABELS: { [F in EnumField]: Record<(typeof ENUMS)[F][number], string> } = {
  type_style: {
    geometric_sans: 'Geometric sans', humanist_sans: 'Humanist sans', serif: 'Serif', mono: 'Mono',
    script: 'Script', display: 'Display', none: 'None',
  },
  spacing_density: { tight: 'Tight', balanced: 'Balanced', airy: 'Airy' },
  layout: {
    grid: 'Grid', modular: 'Modular', freeform: 'Freeform', centered: 'Centered', asymmetric: 'Asymmetric',
    n_a: 'Doesn’t apply',
  },
  medium: {
    photo: 'Photo', render: 'Render', illustration: 'Illustration', ui: 'UI', type_specimen: 'Type specimen',
    object: 'Object', space: 'Space', motion_still: 'Motion still',
  },
};
/** The label for one enum value; a value the app doesn't know (an older or newer backend) reads as capitalised words. */
export function enumValueLabel(field: EnumField, value: string | null | undefined): string {
  const map = ownLabel<Record<string, string>>(ENUM_VALUE_LABELS, field);
  return (map ? ownLabel<string>(map, value) : undefined) ?? words(value);
}
/** The field names the detail panel shows above each enum select. */
export const ENUM_FIELD_LABELS: Record<EnumField, string> = {
  type_style: 'Type style', spacing_density: 'Spacing', layout: 'Layout', medium: 'Medium',
};
/** A field key's name for a person: the detail panel's words for an enum field, else the key as capitalised words. */
export function enumFieldLabel(key: string | null | undefined): string {
  return ownLabel<string>(ENUM_FIELD_LABELS, key) ?? words(key);
}
export const TEXT_FIELDS = ['summary', 'subject', 'composition_notes'] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

export interface SearchRow {
  id: string; membership_id: string; collection_id: string; collection: string; summary: string | null;
  role: Role; media: Media; made_by: string; analysis_state: AnalysisState;
  /** Why a failed analysis failed (as AssetDetail's); absent from an older backend. */
  last_error_kind?: string | null; in_inbox: boolean;
  comment_count: number; matched: string[]; score: number; blob_key: string; also_in: string[];
}
export interface PaletteEntry { index?: number; hex: string; share: number; is_accent: boolean }
export interface Region { id: string; box: [number, number, number, number]; label: string; note: string | null;
  status: RegionStatus; actor: string }
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
  asset: { id: string; media: Media; width: number | null; height: number | null; made_by: string;
    analysis_state: AnalysisState; last_error: string | null;
    /** Why the analysis failed, for the person's line (backend commons/analysis_errors.py):
     * 'unavailable' | 'unreadable' | 'other' | 'transparent'; absent from a backend before error-copy round 3. */
    last_error_kind?: string | null;
    measurements: Record<string, unknown> | null };
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
  paletteHex: string; paletteDeltaE: number; collection: string; media: '' | Media;
  role: '' | Role; madeBy: '' | MadeBy; correctedOnly: boolean; hasComments: boolean; inbox: boolean;
}
export const EMPTY_FILTERS: FilterState = {
  query: '', axes: {}, keywords: [], paletteHex: '', paletteDeltaE: 10, collection: '', media: '', role: '',
  madeBy: '', correctedOnly: false, hasComments: false, inbox: false,
};
