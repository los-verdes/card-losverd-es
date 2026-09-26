/**
 * Order ids as shown on a page (not in a CSV, a form or a link).
 *
 * A BigCommerce order id is a short number; a Squarespace one, from before
 * February 2023, is 24 hexadecimal characters, which widens every table
 * column it appears in to several times the width of its neighbours. A long
 * id is therefore shown by its ends, with the whole of it in a tooltip and
 * behind its link, and a short one as it is.
 */

/** Longer than any BigCommerce order id, shorter than a Squarespace one. */
const SHORTEN_ABOVE = 12;

export function shortOrderId(orderId: string): string {
  return orderId.length > SHORTEN_ABOVE ? `${orderId.slice(0, 6)}…${orderId.slice(-4)}` : orderId;
}

/** The full id, for a `title`, when the shown one is shortened; otherwise nothing. */
export function fullOrderIdTitle(orderId: string): string | undefined {
  return shortOrderId(orderId) === orderId ? undefined : orderId;
}
