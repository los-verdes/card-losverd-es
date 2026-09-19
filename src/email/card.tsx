/**
 * The membership-card email itself: the message a member receives with their
 * card image and Apple Wallet pass attached (plus a Google Wallet link when
 * that's configured). Shared by the two places that send it:
 *
 * - `/email-card`, the no-login fallback a member requests themselves
 *   (src/member/email-card.tsx);
 * - an admin attributing an order to someone (src/admin/orders.tsx), as a
 *   one-time "here is your card" to the new member;
 * - a new membership order reaching BigCommerce's `Completed` status
 *   (src/email/newOrder.ts), once per order.
 *
 * Nothing else may send it. Emailing cards must never be a side effect of a
 * backfill, a resync, the legacy import, or cutover -- that would mail
 * hundreds of existing members at once.
 */

import type { FC } from "hono/jsx";
import type { Env } from "../index";
import { formatShortDate } from "../lib/dateFormat";
import { SUPPORT_EMAIL } from "../member/layout";
import {
  buildGoogleWalletSaveUrl,
  isGoogleWalletConfigured,
  getApplePassBundle,
  getMemberByEmail,
  isMembershipCurrent,
  renderCardImage,
  type MemberRecord,
} from "../member/artifacts";
import { sendEmail } from "./sendgrid";

export const EMAIL_SUBJECT = "Los Verdes Membership Card Details";
export const CARD_IMAGE_FILENAME = "los-verdes-membership-card.png";
export const APPLE_PASS_FILENAME = "los-verdes-membership-card.pkpass";

/** Why this member is being emailed, which the email says in its footer. */
export type CardEmailReason =
  | { kind: "request"; submittedOn: string }
  | { kind: "attribution" }
  | { kind: "new-order" };

interface CardEmailProps {
  name: string;
  memberId: string;
  expirationDate: string;
  googleWalletUrl: string | null;
  reason: CardEmailReason;
  /** The site's public origin (`PUBLIC_BASE_URL`), no trailing slash. */
  baseUrl: string;
}

function opening(reason: CardEmailReason): string {
  return reason.kind === "request"
    ? "Your requested membership card is attached. Gracias!"
    : "Your Los Verdes membership card is attached. Gracias!";
}

const FOOTERS = {
  attribution: "You're receiving this because a Los Verdes admin attributed a membership to this address.",
  "new-order": "You're receiving this because a Los Verdes membership was purchased for this address.",
} as const;

function footer(props: CardEmailProps): string {
  return props.reason.kind === "request"
    ? `This email was requested via a form submission made at ${props.baseUrl}/email-card at: ${props.reason.submittedOn}.`
    : FOOTERS[props.reason.kind];
}

const CardEmail: FC<CardEmailProps> = (props) => (
  <html lang="en">
    <body style="font-family: system-ui, sans-serif">
      <h1>{EMAIL_SUBJECT}</h1>
      <p>{opening(props.reason)}</p>
      <h2>Los Verdes Membership Card</h2>
      <p>
        {props.name}
        <br />
        Good through {formatShortDate(props.expirationDate)}
        <br />
        Member ID: {props.memberId}
      </p>
      <h2>Downloads</h2>
      <ul>
        <li>Image: {CARD_IMAGE_FILENAME} (attached)</li>
        <li>Apple Wallet: {APPLE_PASS_FILENAME} (attached)</li>
        {props.googleWalletUrl && (
          <li>
            Google Wallet:{" "}
            <a href={props.googleWalletUrl}>Save to Google Wallet</a>
          </li>
        )}
      </ul>
      <p>
        Visit online at{" "}
        <a href={props.baseUrl}>{new URL(props.baseUrl).host}</a>
      </p>
      <p style="font-size: 0.8em; color: #393939">
        This Los Verdes digital membership card is intended for {props.name}. If
        you are not {props.name}, please feel free to delete this email or
        contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> for
        assistance. {footer(props)}
      </p>
    </body>
  </html>
);

function cardEmailText(props: CardEmailProps): string {
  return [
    EMAIL_SUBJECT,
    "",
    opening(props.reason),
    "",
    "Los Verdes Membership Card",
    "--------------------------",
    props.name,
    `Good through ${formatShortDate(props.expirationDate)}`,
    `Member ID: ${props.memberId}`,
    "",
    "Downloads",
    "---------",
    `- Image: ${CARD_IMAGE_FILENAME} (attached)`,
    `- Apple Wallet: ${APPLE_PASS_FILENAME} (attached)`,
    ...(props.googleWalletUrl
      ? [`- Google Wallet: ${props.googleWalletUrl}`]
      : []),
    "",
    `Visit online at: ${props.baseUrl}`,
    "",
    `This Los Verdes digital membership card is intended for ${props.name}.`,
    `If you are not ${props.name}, please feel free to delete this email or contact ${SUPPORT_EMAIL} for assistance.`,
    footer(props),
  ].join("\n");
}

/** The Save to Google Wallet link, or null if it's unconfigured or fails. */
async function googleWalletLink(
  env: Env,
  member: MemberRecord,
): Promise<string | null> {
  if (!isGoogleWalletConfigured(env)) {
    return null;
  }
  try {
    return await buildGoogleWalletSaveUrl(env, member);
  } catch (err) {
    console.error("Email card: Google Wallet link failed; sending without it", {
      memberId: member.member_id,
      error: String(err),
    });
    return null;
  }
}

/**
 * Emails `member` their card. The caller decides whether this member should
 * be emailed at all; this throws on failure, so a caller inside `waitUntil`
 * should catch.
 */
export async function sendMembershipCardEmail(
  env: Env,
  member: MemberRecord & { expiration_date: string },
  reason: CardEmailReason,
): Promise<void> {
  // Sequential: rendering and signing are CPU-bound, so running them
  // concurrently wouldn't finish sooner, and a failure in one would leave
  // the others running on after this function returns.
  const cardImage = await renderCardImage(env, member);
  const applePass = await getApplePassBundle(env, member);
  const googleWalletUrl = await googleWalletLink(env, member);
  const props: CardEmailProps = {
    name: `${member.first_name} ${member.last_name}`.trim(),
    memberId: member.member_id,
    expirationDate: member.expiration_date,
    googleWalletUrl,
    reason,
    baseUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, ""),
  };
  await sendEmail(env, {
    from: { email: env.EMAIL_FROM_ADDRESS, name: env.EMAIL_FROM_NAME },
    to: { email: member.email, name: props.name },
    subject: EMAIL_SUBJECT,
    text: cardEmailText(props),
    html: `<!doctype html>${await (<CardEmail {...props} />)}`,
    attachments: [
      {
        filename: CARD_IMAGE_FILENAME,
        type: "image/png",
        content: cardImage,
      },
      {
        filename: APPLE_PASS_FILENAME,
        type: "application/vnd.apple.pkpass",
        content: applePass,
      },
    ],
    unsubscribeGroupId: env.SENDGRID_UNSUBSCRIBE_GROUP_ID
      ? Number(env.SENDGRID_UNSUBSCRIBE_GROUP_ID)
      : undefined,
  });
}

/**
 * The member a card email would go to: null when email isn't configured, the
 * address has no member row, or that membership isn't current. Separate from
 * sending so a caller can check eligibility *before* doing anything it can't
 * undo, such as claiming an order's one send (src/email/newOrder.ts).
 * Addresses are never logged -- Workers Logs keeps lines for 7 days.
 */
export async function findCardRecipient(
  env: Env,
  email: string,
): Promise<(MemberRecord & { expiration_date: string }) | null> {
  if (!env.SENDGRID_API_KEY) {
    console.warn("Card email: SENDGRID_API_KEY not configured, not sending");
    return null;
  }
  const member = await getMemberByEmail(env, email);
  if (!member || !isMembershipCurrent(member)) {
    return null;
  }
  // Non-null: isMembershipCurrent() requires an expiration date.
  return { ...member, expiration_date: member.expiration_date! };
}

/**
 * Emails `member` their card, logging rather than throwing on failure --
 * callers are a `waitUntil` or a queue consumer that must not fail over an
 * email. Returns whether a message was sent.
 */
export async function emailCardTo(
  env: Env,
  member: MemberRecord & { expiration_date: string },
  reason: CardEmailReason,
): Promise<boolean> {
  try {
    await sendMembershipCardEmail(env, member, reason);
    console.log("Card email sent", { memberId: member.member_id, reason: reason.kind });
    return true;
  } catch (err) {
    console.error("Card email failed", { reason: reason.kind, error: String(err) });
    return false;
  }
}

/** Looks the member up and emails them, if they're eligible. Never throws. */
export async function emailMemberCard(
  env: Env,
  email: string,
  reason: CardEmailReason,
): Promise<boolean> {
  try {
    const member = await findCardRecipient(env, email);
    return member ? await emailCardTo(env, member, reason) : false;
  } catch (err) {
    console.error("Card email failed", { reason: reason.kind, error: String(err) });
    return false;
  }
}
