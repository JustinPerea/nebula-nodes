/**
 * How the canvas reads a Jev result: the pieces of a parsed JevResult (see
 * jev.ts) that the node card and the Inspector both show, plus the upstream
 * images a Pick Best or Box result refers to.
 *
 * Everything here is pure and never throws, so a strange result shows less,
 * never breaks the card.
 */
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../types';
import { JEV_BOX, JEV_DECIDE, JEV_PICK_BEST, type JevDecideResult, type JevReport, type JevVerdict } from './jev';
import { formatUsd } from './pricing';

/** TypeSafe bills input tokens only, at $0.042 per million (output is free).
 * The same rate backs the jev-* entries in backend/data/model_pricing.json. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/** The node's own default for min_confidence; below it a result is "unsure". */
export const JEV_DEFAULT_MIN_CONFIDENCE = 0.5;

export type JevDecideMode = 'yes_no' | 'choice' | 'score';

/** The one setting each Jev card lets you type on its face: the question for
 * Decide and Pick Best, the target for Box. The card edits the same node param
 * the Inspector does. */
export interface JevCardField {
  key: string;
  label: string;
  /** Box's target is a short phrase, so it gets a one-line input. */
  multiline: boolean;
}

export const JEV_CARD_FIELDS: Readonly<Record<string, JevCardField>> = {
  [JEV_PICK_BEST]: { key: 'question', label: 'Question', multiline: true },
  [JEV_DECIDE]: { key: 'question', label: 'Question', multiline: true },
  [JEV_BOX]: { key: 'target', label: 'Find', multiline: false },
};

/** The text a Jev card's field stands for right now: what's typed, or the
 * param's default when it's blank (Pick Best asks its default question then). */
export function jevCardText(params: Record<string, unknown> | undefined, key: string, fallback: unknown): string {
  const typed = params?.[key];
  if (typeof typed === 'string' && typed.trim()) return typed.trim();
  return typeof fallback === 'string' ? fallback.trim() : '';
}

/** "93%", "<1%", ">99%". Whole percents read faster on a card than decimals. */
export function formatJevPercent(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (value > 0 && value < 0.005) return '<1%';
  if (value < 1 && value > 0.995) return '>99%';
  return `${Math.round(value * 100)}%`;
}

/** Clamped to 0..1 for widths and positions. */
export function unit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** A float param as saved on the node, or the fallback when unset or odd. */
export function numberParam(params: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const raw = params?.[key];
  const value = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/** Which kind of question a Decide result answered. The report title is
 * written by the run itself, so it wins over params edited since. */
export function decideMode(result: JevDecideResult, params?: Record<string, unknown>): JevDecideMode {
  const title = result.report?.title ?? '';
  if (/\(yes\/no\)/.test(title)) return 'yes_no';
  if (/\(choice\)/.test(title)) return 'choice';
  if (/\(score\)/.test(title)) return 'score';
  const saved = params?.answer_type;
  if (saved === 'yes_no' || saved === 'choice' || saved === 'score') return saved;
  const keys = Object.keys(result.probabilities);
  return keys.length === 2 && keys.includes('yes') && keys.includes('no') ? 'yes_no' : 'choice';
}

/** Probabilities as rows. Score levels keep the saved low-to-high order when
 * it matches (JavaScript moves integer-like keys first, so a level named "2"
 * can't be trusted to keep its place in the JSON). */
export function probabilityRows(
  result: { probabilities: Record<string, number> },
  orderHint?: string[],
): Array<{ label: string; value: number }> {
  const entries = Object.entries(result.probabilities);
  if (orderHint && orderHint.length === entries.length && orderHint.every((label) => label in result.probabilities)) {
    return orderHint.map((label) => ({ label, value: result.probabilities[label] }));
  }
  return entries.map(([label, value]) => ({ label, value }));
}

/** One line per non-empty entry, trimmed, as the backend's split_lines reads it. */
export function splitLines(value: unknown): string[] {
  return typeof value === 'string' ? value.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

export interface JevVerdictLabel {
  tone: 'pass' | 'fail' | 'unsure';
  label: string;
}

/** The chip on a Decide card. A choice with no passing options set only says
 * whether the answer is confident enough to use, so it never says "Pass". */
export function verdictLabel(pass: JevVerdict, mode: JevDecideMode, params?: Record<string, unknown>): JevVerdictLabel {
  if (pass === 'unsure') return { tone: 'unsure', label: 'Unsure' };
  if (mode === 'choice' && splitLines(params?.pass_when).length === 0) {
    return { tone: 'pass', label: 'Confident' };
  }
  return pass === 'true' ? { tone: 'pass', label: 'Pass' } : { tone: 'fail', label: 'Fail' };
}

/** What was asked, from the run's report, or the saved param as a fallback. */
export function askedQuestion(report: JevReport | null, params: Record<string, unknown> | undefined, key: string, field: string): string | null {
  const fromReport = report?.fields[field];
  if (fromReport && fromReport.trim()) return fromReport.trim();
  const saved = params?.[key];
  return typeof saved === 'string' && saved.trim() ? saved.trim() : null;
}

/** True when the request carried images, which TypeSafe marks experimental. */
export function judgedImages(report: JevReport | null): boolean {
  const images = report?.fields.Images;
  return Boolean(images && /^[1-9]\d*\b/.test(images));
}

/** "jev-latest" when the node asked for a moving alias, else null. */
export function requestedAlias(report: JevReport | null): string | null {
  const match = report?.fields.Model?.match(/\(asked for ([^)]+)\)/);
  return match ? match[1] : null;
}

/** The cost of the run from its input tokens, e.g. "$0.000013". */
export function jevRunCost(report: JevReport | null): string | null {
  if (!report || report.inputTokens === null) return null;
  return formatUsd(report.inputTokens * JEV_USD_PER_INPUT_TOKEN);
}

/** A Pick Best whose confidence is under the node's minimum: any would do. */
export function isCloseCall(confidence: number, params?: Record<string, unknown>): boolean {
  return confidence < numberParam(params, 'min_confidence', JEV_DEFAULT_MIN_CONFIDENCE);
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item !== '');
  return [];
}

/**
 * The values wired into one input port, in the order the engine joins them:
 * edge order, each edge's value (a list is spread). An image-input that hasn't
 * run yet offers its picked file. Live graph state, so a caller must check it
 * still matches the result before trusting it.
 */
export function upstreamPortValues(
  nodeId: string,
  port: string,
  nodes: Node[],
  edges: Edge[],
): string[] {
  const values: string[] = [];
  for (const edge of edges) {
    if (edge.target !== nodeId || edge.targetHandle !== port) continue;
    const source = nodes.find((candidate) => candidate.id === edge.source);
    if (!source) continue;
    const data = source.data as NodeData;
    const output = edge.sourceHandle ? data.outputs?.[edge.sourceHandle] : undefined;
    const fromOutput = stringValues(output?.value);
    if (fromOutput.length) {
      values.push(...fromOutput);
    } else if (data.definitionId === 'image-input' && typeof data.params?._previewUrl === 'string') {
      values.push(...stringValues(data.params._previewUrl));
    }
  }
  return values;
}

/** Pick Best candidates as wired, but only when they still line up with the
 * result: same count, and the winner sits at the reported index. */
export function matchingCandidates(
  wired: string[],
  result: { winner: string; index: number; probabilities: Record<string, number> },
): string[] | null {
  const count = Object.keys(result.probabilities).length;
  if (wired.length !== count || wired[result.index] !== result.winner) return null;
  return wired;
}

/** A stable key for one result, so its reveal motion replays only when the
 * result itself changes. */
export function jevResultKey(outputs: Record<string, unknown>): string {
  try {
    return JSON.stringify(outputs);
  } catch {
    return '';
  }
}
