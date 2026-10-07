import type { EvaluationLabels, EvaluationState } from './commonsEvaluationTypes';

type Explained<T> = { value: T; why: string };
export type ReviewItem = {
  position: number;
  width: number;
  height: number;
  image_sha256: string;
  status: 'pending' | 'running' | 'ready' | 'failed';
  revision: number;
  palette?: { index: number; hex: string; share: number }[];
  proposal: {
    labels: EvaluationLabels;
    fields: {
      summary: Explained<string>;
      composition_notes: Explained<string>;
      axes: Record<string, Explained<number>>;
    } & Record<string, unknown>;
    model: string;
    prompt_version: string;
  } | null;
  reviewed_labels: EvaluationLabels | null;
  reviewer: string | null;
  reviewed_at: string | null;
  error: string | null;
};
export type ReviewBatch = {
  mode: 'assisted_review';
  independent_ground_truth: false;
  state: EvaluationState;
  batch_revision: number;
  closed_at: string | null;
  close_hash: string | null;
  manifest_hash: string;
  items: ReviewItem[];
  model: string;
  fields: Record<string, string[]>;
  axes: string[];
  roles: string[];
  keywords: string[];
  call_budget: number;
  attempts: number;
};
