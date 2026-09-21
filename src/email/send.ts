/**
 * The one way out of this codebase for an email.
 *
 * Everything that decides *whether* a message may be sent lives here rather
 * than beside the transport, so that the allow-list cannot be stepped around
 * by calling the transport directly. `sendEmail()` takes the whole `env` for
 * the same reason: a caller cannot reach the binding without it.
 *
 * Mail goes out through Cloudflare Email Service's `send_email` binding
 * (#244; ./cloudflare.ts).
 */

import { type SendEmailBinding, sendViaBinding } from "./cloudflare";

/**
 * What sending needs from the environment. Narrower than `Env` so this stays
 * a send path rather than something that knows about the whole Worker, and so
 * a test can hand it two fields.
 */
export interface EmailEnv {
  /** Cloudflare Email Service. Absent only where a test removes it. */
  EMAIL?: SendEmailBinding;
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
 * Production carries whichever it means explicitly, so granting it is an edit
 * someone made on purpose rather than a default arriving by omission -- and
 * an environment that loses the var goes quiet rather than open.
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
 * recipient. Throws (without retrying) if the binding is missing, or if it
 * rejects the message.
 */
export async function sendEmail(
  env: EmailEnv,
  message: EmailMessage,
): Promise<void> {
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
  if (!env.EMAIL) {
    throw new Error(
      "No email transport: this environment has no Cloudflare Email Service binding (`send_email` named EMAIL in wrangler.toml)",
    );
  }
  return sendViaBinding(env.EMAIL, message);
}
