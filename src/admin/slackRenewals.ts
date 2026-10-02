/**
 * Lapsed members who are still in Slack, sorted by what MiniBC says about
 * their automatic renewal (#397), for the Slack cross-reference.
 *
 * The three groups ask different things of whoever reads them:
 *
 * - **Renewal still on:** MiniBC means to renew them, but the membership
 *   card has run out, so a payment failed or has not been tried yet. These
 *   usually sort themselves out, or need a nudge about the payment method on
 *   file.
 * - **Renewal cancelled or paused:** they had automatic renewal and turned it
 *   off.
 * - **Never renewed automatically:** no subscription matched to them at all.
 *
 * Matching is the Renewals report's own (src/minibc/renewals.ts): through
 * orders, never an address. Informational only, like everything MiniBC
 * feeds here.
 */

import { renewalState, renewalText, type RenewalRow } from "../minibc/renewals";
import type { SlackCrossReferenceRow } from "./reportQueries";

export interface LapsedWithRenewal extends SlackCrossReferenceRow {
  /** What MiniBC says, in a line; null when no subscription matched. */
  renewal: string | null;
}

export interface LapsedByRenewal {
  renewalOn: LapsedWithRenewal[];
  renewalOff: LapsedWithRenewal[];
  noRenewal: LapsedWithRenewal[];
}

/**
 * The subscription that speaks for a member with several: an active one if
 * any, else the one most recently due. The same order the member page lists
 * them in.
 */
function leading(subscriptions: RenewalRow[]): RenewalRow {
  return [...subscriptions].sort(
    (a, b) =>
      Number(b.status === "active") - Number(a.status === "active") ||
      (b.next_payment_on ?? "").localeCompare(a.next_payment_on ?? "") ||
      b.subscription_id - a.subscription_id,
  )[0];
}

export function splitLapsedByRenewal(
  lapsed: SlackCrossReferenceRow[],
  renewals: RenewalRow[],
  today: string,
): LapsedByRenewal {
  const byEmail = new Map<string, RenewalRow[]>();
  for (const row of renewals) {
    if (!row.member_email) continue;
    const email = row.member_email.toLowerCase();
    byEmail.set(email, [...(byEmail.get(email) ?? []), row]);
  }
  const split: LapsedByRenewal = { renewalOn: [], renewalOff: [], noRenewal: [] };
  for (const row of lapsed) {
    const subscriptions = byEmail.get(row.email.toLowerCase());
    if (!subscriptions) {
      split.noRenewal.push({ ...row, renewal: null });
      continue;
    }
    const subscription = leading(subscriptions);
    const state = renewalState(subscription, subscription.expiration_date, today);
    (state.kind === "paused" || state.kind === "cancelled" ? split.renewalOff : split.renewalOn).push({
      ...row,
      renewal: renewalText(state),
    });
  }
  return split;
}
