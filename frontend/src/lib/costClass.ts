import type { ModelNodeDefinition } from '../types';
import { keyBilling } from './directRoute';
import { usesKreaAccount } from './kreaConnection';

/**
 * The cost classes of a node that calls a provider: what every cost surface
 * counts it as. Only "paid" is in "N paid", the paid lead and the figure;
 * "plan" runs on the person's Krea plan ("1 on Krea plan"; GM, PR #203 r19
 * item 1); "mayCost" may bill the person's own account with their key (Idol
 * with a Hugging Face token); "free" is a key-billing route with no key, or a
 * sourced $0 (GM, PR #203 r18 item 1).
 */
export type CostClass = 'paid' | 'plan' | 'mayCost' | 'free';

/** A node's own estimate (pricing estimateNode) that is a sourced $0: priced
 * in USD at exactly 0, with nothing its price leaves out. */
export function sourcedZero(estimate: { currency: string; low: number; high: number; plus?: string } | null | undefined): boolean {
  return Boolean(estimate) && estimate!.currency === 'usd' && estimate!.low === 0 && estimate!.high === 0 && !estimate!.plus;
}

/**
 * The one cost class of a node that calls a provider (callers leave out local
 * nodes first), with `params` routed (directRoute withWiredBlockers) and the
 * person's keys: a key-billing route's own class (directRoute keyBilling),
 * else "plan" for a run on the Krea plan, else "free" when `estimate`, the
 * node's own price, is a sourced $0, else "paid". model_pricing.cost_class
 * is the twin (backend/tests/fixtures/pricing_cases.json classCases pins
 * both). summarizeRunScope, liveKeyBilling and the placeholder dialog read
 * it; nothing else reads keyBilling or usesKreaAccount to count a node
 * (tests/idolRound10.test.ts).
 */
export function costClass(
  definition: ModelNodeDefinition,
  params: Record<string, unknown>,
  apiKeys: Readonly<Record<string, string>>,
  estimate?: Parameters<typeof sourcedZero>[0],
): CostClass {
  const billing = keyBilling(definition, params, apiKeys);
  if (billing) return billing;
  if (usesKreaAccount(definition, params)) return 'plan';
  if (sourcedZero(estimate)) return 'free';
  return 'paid';
}

/** Each counted class's part of a cost chip, in the chips' order: "2 paid",
 * "1 on Krea plan", "1 may cost". Free runs are never counted. */
export function classCounts({ paid = 0, plan = 0, mayCost = 0 }: { paid?: number; plan?: number; mayCost?: number }): string[] {
  return [paid > 0 ? `${paid} paid` : '', plan > 0 ? `${plan} on Krea plan` : '', mayCost > 0 ? `${mayCost} may cost` : '']
    .filter(Boolean);
}

/**
 * A cost chip from its parts, by one rule (GM, PR #203 r20): "+" joins
 * money, "·" joins classes. `money` is the amount, already joined by "+" to
 * any unpriced part ("$0.07 + unpriced": pricing formatChipEstimate), and
 * `classes` are the counted classes (classCounts), so the chip reads
 * "$0.07 + unpriced · 1 on Krea plan", "2 paid · 1 on Krea plan" or
 * "~$0.13 · 1 may cost". Null with neither. The Run chip (runScope
 * runChipLabel) and the Accept chip (canvasProposals acceptCountChip) are
 * both written with it.
 */
export function costChip(money: string | null, classes: readonly string[]): string | null {
  return [money ?? '', ...classes].filter(Boolean).join(' · ') || null;
}
