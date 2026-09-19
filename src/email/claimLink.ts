/**
 * The "confirm this is your membership" email (#144).
 *
 * Carries a link and nothing else. Notably it carries no card: the standing
 * rule for this project is that a membership card is never emailed as a side
 * effect of some other action, and a member proving control of an address has
 * not asked for their card. They get it on the page once the claim completes.
 *
 * Nor does it say anything about the membership it would link -- no name, no
 * expiry, no order. Someone who typed an address they do not own learns only
 * that a mail was sent, which is what the anti-enumeration behaviour of the
 * form in front of it is for. Undoing that here would be easy to miss.
 */

import type { Env } from "../index";
import { sendEmail } from "./sendgrid";

export const CLAIM_EMAIL_SUBJECT = "Confirm your Los Verdes membership";

export function claimEmailText(confirmUrl: string): string {
  return [
    "Someone signed in to the Los Verdes membership card site and asked to",
    "link this email address to their account.",
    "",
    "If that was you, confirm it here:",
    confirmUrl,
    "",
    "The link works for the next 30 minutes, and only in the browser you",
    "signed in with. If it has expired, sign in again and ask for a new one.",
    "",
    "If this wasn't you, you can ignore this email. Nothing has changed, and",
    "no one can see your membership without following that link while signed",
    "in as the account that asked for it.",
  ].join("\n");
}

export function claimEmailHtml(confirmUrl: string): string {
  return [
    "<!doctype html>",
    '<html><body style="font-family: system-ui, sans-serif; line-height: 1.5">',
    "<p>Someone signed in to the Los Verdes membership card site and asked to",
    "link this email address to their account.</p>",
    `<p><a href="${confirmUrl}">Confirm your membership</a></p>`,
    "<p>The link works for the next 30 minutes, and only in the browser you",
    "signed in with. If it has expired, sign in again and ask for a new one.</p>",
    "<p>If this wasn't you, you can ignore this email. Nothing has changed, and",
    "no one can see your membership without following that link while signed in",
    "as the account that asked for it.</p>",
    "</body></html>",
  ].join("\n");
}

/** Throws on failure, like the other senders; callers run inside `waitUntil`. */
export async function sendClaimLinkEmail(
  env: Env,
  recipient: string,
  confirmUrl: string,
): Promise<void> {
  await sendEmail(env, {
    from: { email: env.EMAIL_FROM_ADDRESS, name: env.EMAIL_FROM_NAME },
    to: { email: recipient },
    subject: CLAIM_EMAIL_SUBJECT,
    text: claimEmailText(confirmUrl),
    html: claimEmailHtml(confirmUrl),
    // No unsubscribe group: this is a transactional reply to something the
    // member just did, not membership mail they could reasonably opt out of
    // and still expect to work.
  });
}
