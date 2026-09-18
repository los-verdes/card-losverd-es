/**
 * Bringing both wallets up to date after a member's pass-visible details
 * change, from the one place callers already had for Apple.
 *
 * The two wallets need opposite things. An Apple pass lives on the device, so
 * Apple is told to come and fetch a new one (`notifyPassUpdated`). A Google
 * pass lives on Google's servers, so the new contents are written to them
 * (`refreshGoogleWalletObject`). Until #28 only the first happened, which
 * left a saved Google pass stale until the member next opened their card
 * page and a save link was built.
 *
 * Neither failure stops a caller: these run from the order sync and from an
 * admin action, and neither should fail because a wallet provider was
 * briefly unreachable. A missed refresh is repaired by the next change, or
 * by the member opening their card.
 */

import type { Env } from "../index";
import { notifyPassUpdated } from "../passkit/updates";
import { getMemberById, refreshGoogleWalletObject } from "./artifacts";

/**
 * Call after `refreshMemberFromOrders()` reports `passChanged`, with the
 * member id (which is also the pass serial number).
 */
export async function notifyWalletsUpdated(
  env: Env,
  memberId: string,
): Promise<void> {
  await notifyPassUpdated(env, memberId);

  try {
    const member = await getMemberById(env, memberId);
    if (!member) {
      // Raced with a deletion, or the id was never real. Apple's side logs
      // its own miss; there is nothing to write to Google either way.
      return;
    }
    const outcome = await refreshGoogleWalletObject(env, member);
    if (outcome === "updated") {
      console.log("Google Wallet object refreshed", { memberId });
    }
  } catch (error) {
    console.error("Google Wallet refresh failed", {
      memberId,
      error: String(error),
    });
  }
}
