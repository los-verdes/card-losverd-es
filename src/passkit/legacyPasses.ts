/**
 * Passes issued by the previous site, still installed on some phones.
 *
 * They point at the same web service (`card.losverd.es/passkit`), so their
 * phones keep trying to register for updates here -- and always have: the
 * previous site answered 404, and this one would answer 401, because their
 * serials are not members here and their auth tokens were never imported
 * (docs/legacy-pass-compatibility.md, decision D1). Wallet retries a failed
 * registration indefinitely and reports every failure to `/v1/log`.
 *
 * So for a serial that is one of those cards, registering and unregistering
 * are acknowledged and nothing is stored, and asking for a newer copy is
 * answered "not modified". The phone considers itself registered and stops
 * retrying; the old pass stays exactly as it was. A member wanting a pass
 * that updates downloads their current one from the site.
 */

import type { Env } from "../index";

/**
 * The card UUID behind a legacy serial. The previous site wrote each pass's
 * serial as the card UUID's 128-bit integer (`card.serial_number.int`); the
 * import kept the hyphenated form the QR codes use. `null` for anything that
 * is not such an integer.
 */
export function legacyCardUuid(serial: string): string | null {
  if (!/^\d{1,39}$/.test(serial)) return null;
  const value = BigInt(serial);
  if (value >= 1n << 128n) return null;
  const hex = value.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether this serial is a card the previous site issued. */
export async function isLegacyPassSerial(env: Env, serial: string): Promise<boolean> {
  const uuid = legacyCardUuid(serial);
  if (uuid === null) return false;
  const row = await env.DB.prepare("SELECT 1 AS present FROM legacy_membership_cards WHERE serial_number = ?")
    .bind(uuid)
    .first<{ present: number }>();
  return row !== null;
}
