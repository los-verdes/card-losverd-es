/**
 * Minimal SendGrid v3 Mail Send client (`POST /v3/mail/send`), used for
 * email card delivery (src/member/email-card.tsx). Mirrors the legacy app's
 * member_card/sendgrid.py: one recipient per message, optionally sent under
 * an ASM unsubscribe group -- but with inline HTML/text content and the card
 * artifacts as attachments rather than a hosted dynamic template.
 */

import { bytesToBase64 } from "../lib/base64";

export const SENDGRID_SEND_URL = "https://api.sendgrid.com/v3/mail/send";

/**
 * What sending needs from the environment. Narrower than `Env` so this stays
 * a SendGrid client rather than something that knows about the whole Worker,
 * and so a test can hand it two fields.
 */
export interface EmailEnv {
  SENDGRID_API_KEY?: string;
  /** `*` for anyone, empty for nobody, else addresses and domains (#155). */
  EMAIL_RECIPIENT_ALLOWLIST?: string;
}

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailAttachment {
  filename: string;
  /** MIME type, e.g. `image/png`. */
  type: string;
  content: Uint8Array;
}

export interface EmailMessage {
  from: EmailAddress;
  to: EmailAddress;
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[];
  /** SendGrid ASM (unsubscribe) group ID; omitted when undefined. */
  unsubscribeGroupId?: number;
}

export function buildMailSendBody(message: EmailMessage) {
  return {
    from: message.from,
    personalizations: [{ to: [message.to] }],
    subject: message.subject,
    // SendGrid requires text/plain to precede text/html.
    content: [
      { type: "text/plain", value: message.text },
      { type: "text/html", value: message.html },
    ],
    attachments: message.attachments?.map((attachment) => ({
      content: bytesToBase64(attachment.content),
      filename: attachment.filename,
      type: attachment.type,
      disposition: "attachment",
    })),
    asm:
      message.unsubscribeGroupId === undefined
        ? undefined
        : { group_id: message.unsubscribeGroupId },
  };
}

/** The one value of `EMAIL_RECIPIENT_ALLOWLIST` that permits any address. */
export const ALLOW_ANY_RECIPIENT = "*";

/** Allow-list entries, lowercased; commas or whitespace separate them. */
export function parseRecipientAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether this environment is allowed to email `address`
 * (los-verdes/card-losverd-es#155).
 *
 * The value means the same thing wherever it is read, which is the point:
 * empty permits nobody, `*` permits anyone, and anything else is the list.
 * Production carries `*` explicitly, so granting it is an edit someone made
 * on purpose rather than a default arriving by omission -- and an
 * environment that loses the var goes quiet rather than open.
 *
 * An entry containing `@` is a whole address; one without is a domain, which
 * is what makes `card-test+expired@losverd.es` work without listing every
 * variation. Domains match exactly rather than by suffix: a suffix rule
 * would quietly let `verd.es` cover `losverd.es`, and an allow-list that
 * matches more than it appears to is worse than no allow-list.
 */
export function allowsRecipient(
  raw: string | undefined,
  address: string,
): boolean {
  const entries = parseRecipientAllowlist(raw);
  if (entries.includes(ALLOW_ANY_RECIPIENT)) return true;
  const recipient = address.trim().toLowerCase();
  const domain = recipient.slice(recipient.lastIndexOf("@") + 1);
  return entries.some((entry) =>
    entry.includes("@") ? entry === recipient : entry === domain,
  );
}

/**
 * Sends one message, unless this environment isn't allowed to email that
 * recipient. Throws (without retrying) if the API key is unset or SendGrid
 * doesn't accept the message.
 *
 * Takes the whole `env` rather than just the API key so that the allow-list
 * cannot be bypassed by a future caller: there is no way to reach SendGrid
 * from this codebase without passing through the check below.
 */
export async function sendEmail(
  env: EmailEnv,
  message: EmailMessage,
): Promise<void> {
  const apiKey = env.SENDGRID_API_KEY;
  if (!allowsRecipient(env.EMAIL_RECIPIENT_ALLOWLIST, message.to.email)) {
    // Always logged, never silent. The case this is written for is someone
    // testing delivery from staging long after this was added, finding that
    // nothing arrives, and having no idea why -- this line is the whole
    // difference between a puzzle and an answer.
    //
    // The domain, not the address: a suppressed recipient is exactly the one
    // that might be a real member's, and Workers Logs keeps lines for seven
    // days. The domain plus the configured list is enough to explain the
    // decision without writing someone's address down.
    console.warn("Email suppressed: recipient not allowed in this environment", {
      recipientDomain: message.to.email.slice(message.to.email.lastIndexOf("@") + 1),
      allowlist: env.EMAIL_RECIPIENT_ALLOWLIST || "(empty -- nobody)",
      subject: message.subject,
    });
    return;
  }
  if (!apiKey) {
    throw new Error("SENDGRID_API_KEY is not configured");
  }
  const res = await fetch(SENDGRID_SEND_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(buildMailSendBody(message)),
  });
  if (!res.ok) {
    throw new Error(
      `SendGrid mail send failed: HTTP ${res.status} ${await res.text()}`,
    );
  }
}
