/**
 * The membership-card email itself: the message a member receives with their
 * card image shown in it (inline, so it can also be saved) and their Apple
 * Wallet pass attached, plus a Save to Google Wallet button when that's
 * configured. Shared by the two places that send it:
 *
 * - `/email-card`, the no-login fallback a member requests themselves
 *   (src/member/email-card.tsx);
 * - an admin attributing an order to someone (src/admin/orders.tsx), as a
 *   one-time "here is your card" to the new member;
 * - a new membership order reaching BigCommerce's `Completed` status
 *   (src/email/newOrder.ts), once per order.
 *
 * Nothing else may send it. Emailing cards must never be a side effect of a
 * backfill, a resync, or a data import or reload -- that would mail
 * hundreds of existing members at once.
 */

import type { FC } from "hono/jsx";
import type { Env } from "../index";
import { recordAuditEventBestEffort } from "../audit/log";
import { formatShortDate } from "../lib/dateFormat";
import { SUPPORT_EMAIL } from "../member/layout";
import { VERDE_INK } from "../styles";
import {
  buildGoogleWalletSaveUrl,
  isGoogleWalletConfigured,
  getApplePassBundle,
  getMemberByEmail,
  isMembershipCurrent,
  renderCardImage,
  type MemberRecord,
  cardNameText,
} from "../member/artifacts";
import { recordOutcome } from "../lib/outcome";
import { sendEmail, type SendOutcome } from "./send";

export const EMAIL_SUBJECT = "Los Verdes Membership Card Details";
export const CARD_IMAGE_FILENAME = "los-verdes-membership-card.png";
export const APPLE_PASS_FILENAME = "los-verdes-membership-card.pkpass";

/** Why this member is being emailed, which the email says in its footer. */
export type CardEmailReason =
  | { kind: "request"; submittedOn: string }
  | { kind: "attribution" }
  | { kind: "new-order" };

/** Why a card went out, as the audit log reports it. */
const EMAIL_REASONS: Record<CardEmailReason["kind"], string> = {
  request: "They asked for it from /email-card",
  attribution: "An order was re-attributed to them",
  "new-order": "Their new order completed",
};

export interface CardEmailProps {
  name: string;
  memberId: string;
  expirationDate: string;
  googleWalletUrl: string | null;
  reason: CardEmailReason;
  /** The site's public origin (`PUBLIC_BASE_URL`), no trailing slash. */
  baseUrl: string;
}

/** How the HTML refers to the card image, which travels inline (`cid:`) rather than only attached. */
export const CARD_IMAGE_CONTENT_ID = "membership-card";

function opening(reason: CardEmailReason): string {
  return reason.kind === "request"
    ? "Here's the membership card you asked for. Gracias!"
    : "Here's your Los Verdes membership card. Gracias!";
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

/*
 * Email HTML is its own dialect: one centred table no wider than 600px,
 * every style inline (Gmail drops <style> in some views, Outlook most of
 * CSS), and colours stated on each cell so a client's dark mode has
 * something definite to invert. The page's own tokens (src/styles.ts) are
 * the source of the colours.
 */
const INK = "#14181f";
const MUTED = "#555555";
const PAGE = "#eef5f0";
const RULE = "#d8e8dd";
const FONT = "font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const Detail: FC<{ label: string; value: string }> = ({ label, value }) => (
  <tr>
    <td style={`${FONT}; padding: 8px 0; border-bottom: 1px solid ${RULE}; color: ${MUTED}; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em`}>
      {label}
    </td>
    <td align="right" style={`${FONT}; padding: 8px 0; border-bottom: 1px solid ${RULE}; color: ${INK}; font-size: 16px; font-weight: 600`}>
      {value}
    </td>
  </tr>
);

const Button: FC<{ href: string; label: string; primary?: boolean }> = ({ href, label, primary }) => (
  <a
    href={href}
    style={`${FONT}; display: inline-block; padding: 12px 22px; margin: 4px 0; border-radius: 999px; font-size: 15px; font-weight: 600; text-decoration: none; ${
      primary ? `background-color: ${INK}; color: #ffffff; border: 2px solid ${INK}` : `background-color: #ffffff; color: ${VERDE_INK}; border: 2px solid ${VERDE_INK}`
    }`}
  >
    {label}
  </a>
);

const CardEmail: FC<CardEmailProps> = (props) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="color-scheme" content="light dark" />
      <meta name="supported-color-schemes" content="light dark" />
      <title>{EMAIL_SUBJECT}</title>
    </head>
    <body style={`margin: 0; padding: 0; background-color: ${PAGE}`}>
      {/* The preview line a mail app shows beside the subject. */}
      <div style="display: none; max-height: 0; overflow: hidden; opacity: 0">
        Your Los Verdes membership card, good through {formatShortDate(props.expirationDate)}.
      </div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style={`background-color: ${PAGE}`}>
        <tr>
          <td align="center" style="padding: 24px 12px">
            <table
              role="presentation"
              width="100%"
              cellpadding="0"
              cellspacing="0"
              style="max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden"
            >
              <tr>
                <td style={`${FONT}; background-color: ${VERDE_INK}; padding: 18px 24px; color: #ffffff`}>
                  <img
                    src={`${props.baseUrl}/assets/crest.png`}
                    width="40"
                    height="40"
                    alt=""
                    style="display: inline-block; vertical-align: middle; border: 0; margin-right: 12px"
                  />
                  <span style="font-size: 20px; font-weight: 700; vertical-align: middle; color: #ffffff">Los Verdes</span>
                </td>
              </tr>
              <tr>
                <td style={`${FONT}; padding: 28px 24px 8px; color: ${INK}`}>
                  <h1 style={`${FONT}; margin: 0 0 8px; font-size: 24px; line-height: 1.25; color: ${INK}`}>Your membership card</h1>
                  <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.5">{opening(props.reason)}</p>
                  <img
                    src={`cid:${CARD_IMAGE_CONTENT_ID}`}
                    width="552"
                    alt={`Los Verdes membership card for ${props.name}`}
                    style="display: block; width: 100%; max-width: 552px; height: auto; border: 0; border-radius: 12px"
                  />
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 20px 0 8px">
                    <Detail label="Name" value={props.name} />
                    <Detail label="Good through" value={formatShortDate(props.expirationDate)} />
                    <Detail label="Card number" value={props.memberId} />
                  </table>
                </td>
              </tr>
              <tr>
                <td style={`${FONT}; padding: 16px 24px 28px; color: ${INK}`}>
                  <h2 style={`${FONT}; margin: 0 0 8px; font-size: 18px; color: ${INK}`}>Put it on your phone</h2>
                  {props.googleWalletUrl && (
                    <p style="margin: 0 0 8px">
                      <Button href={props.googleWalletUrl} label="Save to Google Wallet" primary />
                    </p>
                  )}
                  <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.5">
                    On an iPhone, open the attached <strong>{APPLE_PASS_FILENAME}</strong> to add it to Apple Wallet.
                  </p>
                  <p style="margin: 0">
                    <Button href={props.baseUrl} label="See your card online" />
                  </p>
                  <p style={`margin: 8px 0 0; font-size: 13px; color: ${MUTED}`}>
                    <a href={props.baseUrl} style={`color: ${VERDE_INK}`}>
                      {new URL(props.baseUrl).host}
                    </a>
                  </p>
                </td>
              </tr>
              <tr>
                <td style={`${FONT}; background-color: #f6f8f7; border-top: 1px solid ${RULE}; padding: 18px 24px; font-size: 12px; line-height: 1.5; color: ${MUTED}`}>
                  This Los Verdes digital membership card is intended for {props.name}. If you are not {props.name}, please
                  feel free to delete this email or contact{" "}
                  <a href={`mailto:${SUPPORT_EMAIL}`} style={`color: ${VERDE_INK}`}>
                    {SUPPORT_EMAIL}
                  </a>{" "}
                  for assistance. {footer(props)}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>
);

/** The message's HTML body. */
export async function cardEmailHtml(props: CardEmailProps): Promise<string> {
  return `<!doctype html>${await (<CardEmail {...props} />)}`;
}

export function cardEmailText(props: CardEmailProps): string {
  return [
    "Your Los Verdes membership card",
    "",
    opening(props.reason),
    "",
    props.name,
    `Good through ${formatShortDate(props.expirationDate)}`,
    `Card number ${props.memberId}`,
    "",
    `Your card is attached as ${CARD_IMAGE_FILENAME}.`,
    "",
    "Put it on your phone",
    "--------------------",
    ...(props.googleWalletUrl ? [`- Google Wallet: ${props.googleWalletUrl}`] : []),
    `- Apple Wallet: on an iPhone, open the attached ${APPLE_PASS_FILENAME}.`,
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
 * should catch. Says whether it was sent, withheld by the allow-list, or
 * refused because the address is on the suppression list.
 */
export async function sendMembershipCardEmail(
  env: Env,
  member: MemberRecord & { expiration_date: string },
  reason: CardEmailReason,
): Promise<SendOutcome> {
  // Sequential: rendering and signing are CPU-bound, so running them
  // concurrently wouldn't finish sooner, and a failure in one would leave
  // the others running on after this function returns.
  const cardImage = await renderCardImage(env, member);
  const applePass = await getApplePassBundle(env, member);
  const googleWalletUrl = await googleWalletLink(env, member);
  const props: CardEmailProps = {
    name: cardNameText(member),
    memberId: member.member_id,
    expirationDate: member.expiration_date,
    googleWalletUrl,
    reason,
    baseUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, ""),
  };
  return sendEmail(env, {
    from: { email: env.EMAIL_FROM_ADDRESS, name: env.EMAIL_FROM_NAME },
    to: { email: member.email, name: props.name },
    subject: EMAIL_SUBJECT,
    text: cardEmailText(props),
    html: await cardEmailHtml(props),
    attachments: [
      {
        filename: CARD_IMAGE_FILENAME,
        type: "image/png",
        content: cardImage,
        contentId: CARD_IMAGE_CONTENT_ID,
      },
      {
        filename: APPLE_PASS_FILENAME,
        type: "application/vnd.apple.pkpass",
        content: applePass,
      },
    ],
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
  if (!env.EMAIL) {
    console.warn("Card email: the EMAIL binding is not configured, not sending");
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
 * What a card send leaves in the audit log, so "has anything been sent to
 * this person, and when" has one answer -- including "we tried, and
 * Cloudflare would not deliver it". Every path that sends a card calls this;
 * `card_emails` is keyed on the order and cannot answer it.
 *
 * Best effort, and after the send: the message has left (or been refused),
 * so throwing here would leave the caller's only move being to try again.
 * An environment's allow-list withholding a message is not recorded -- that
 * is configuration, not something that happened to this person.
 */
export async function recordCardSend(
  env: Env,
  email: string,
  reason: CardEmailReason,
  outcome: SendOutcome,
): Promise<void> {
  if (outcome === "not-allowed") return;
  if (outcome === "suppressed") {
    recordOutcome("card.suppressed", { reason: reason.kind });
    await recordAuditEventBestEffort(env, {
      action: "card.suppressed",
      subjectEmail: email,
      actorEmail: null,
      detail: `${EMAIL_REASONS[reason.kind]}, but the address is on the email suppression list (a bounce, a spam report, or added by hand), so nothing was sent.`,
    });
    return;
  }
  await recordAuditEventBestEffort(env, {
    action: "card.emailed",
    subjectEmail: email,
    actorEmail: null,
    detail: EMAIL_REASONS[reason.kind],
  });
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
    const outcome = await sendMembershipCardEmail(env, member, reason);
    await recordCardSend(env, member.email, reason, outcome);
    if (outcome !== "sent") return false;
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
