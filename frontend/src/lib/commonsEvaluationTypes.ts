export type AccentPoint = { x: number; y: number; hex?: string };
export type EvaluationLabels = {
  tags: Record<string, string>;
  axes: Record<string, number>;
  palette_roles: Record<string, string>;
  keywords: string[];
  no_keywords: boolean;
  flagged: boolean;
};
export type EvaluationItem = {
  position: number;
  image_sha256: string;
  width: number;
  height: number;
  accent_locked: boolean;
  accents?: AccentPoint[];
  no_accents?: boolean;
  palette?: { index: number; hex: string; share: number }[];
  labels: EvaluationLabels | null;
};
export type EvaluationState = 'open' | 'sealed' | 'closed';
export type EvaluationBatch = {
  revision: number;
  state: EvaluationState;
  items: EvaluationItem[];
  denominator: number;
  tuning_count: number;
  manifest_hash: string;
  sealed: Record<string, unknown> | null;
  seal_hash: string | null;
  closed: Record<string, unknown> | null;
  close_hash: string | null;
  fields: Record<string, string[]>;
  axes: string[];
  roles: string[];
  keywords: string[];
  excluded_count: number;
  /** Agent grading attempts. Any at all means the batch can no longer be sealed as blind labels. */
  assisted_reviews: number;
};

export function evaluationComplete(item: EvaluationItem, batch: EvaluationBatch): boolean {
  const labels = item.labels;
  return !!labels && item.accent_locked && !labels.flagged
    && Object.keys(batch.fields).every((key) => !!labels.tags[key])
    && batch.axes.every((key) => Number.isFinite(labels.axes[key]))
    && !!item.palette && item.palette.every((p) => !!labels.palette_roles[p.index])
    && (labels.keywords.length > 0 || labels.no_keywords);
}
