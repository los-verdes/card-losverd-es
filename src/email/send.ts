/**
 * The one way out of this codebase for an email, whatever carries it.
 *
 * Everything that decides *whether* a message may be sent lives here rather
 * than in either transport, so that adding a second one could not create a
 * second way past the allow-list. `sendEmail()` takes the whole `env` for the
 * same reason: a caller cannot reach a transport without it.
 *
 * Which transport is used is decided by whether the environment has the
 * Cloudflare Email Service binding (#244). Presence rather than a setting,
 * because a binding is declared in `wrangler.toml` per environment and
 * already says plainly which environments have it -- the same shape
 * `apnsConfig()` uses for APNs credentials. An environment with no binding
 * goes to SendGrid, which is what keeps the two switchable one at a time.
 */

import { type SendEmailBinding, sendViaBinding } from "./cloudflare";
import { sendViaSendGrid } from "./sendgrid";

/**
 * What sending needs from the environment. Narrower than `Env` so this stays
 * a send path rather than something that knows about the whole Worker, and so
 * a test can hand it two fields.
 */
export interface EmailEnv {
  /** Cloudflare Email Service. Absent in an environment still on SendGrid. */
  EMAIL?: SendEmailBinding;
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
  /**
   * SendGrid ASM (unsubscribe) group ID; omitted when undefined, and ignored
   * by the Cloudflare transport, which has no equivalent (see ./cloudflare.ts).
   */
  unsubscribeGroupId?: number;
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

/** Which transport an environment will use, for reporting it on a page. */
export function transportName(env: EmailEnv): "cloudflare" | "sendgrid" | null {
  if (env.EMAIL) return "cloudflare";
  return env.SENDGRID_API_KEY ? "sendgrid" : null;
}

/**
 * Sends one message, unless this environment isn't allowed to email that
 * recipient. Throws (without retrying) if nothing is configured to send with,
 * or if the transport rejects the message.
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
  if (env.EMAIL) {
    return sendViaBinding(env.EMAIL, message);
  }
  if (!env.SENDGRID_API_KEY) {
    throw new Error(
      "No email transport configured: this environment has neither the Cloudflare Email Service binding nor SENDGRID_API_KEY",
    );
  }
  return sendViaSendGrid(env.SENDGRID_API_KEY, message);
}
