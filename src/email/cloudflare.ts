/**
 * Sending through Cloudflare Email Service's Worker binding (#244).
 *
 * The binding is the reason to prefer this over SendGrid: there is no API
 * key, so there is no outbound credential to rotate, leak or audit. It is
 * declared in `wrangler.toml` per environment, and an environment without it
 * keeps using SendGrid -- see `sendEmail()` in ./send.ts.
 *
 * Two things this cannot do that SendGrid could, both worth knowing before
 * the last environment moves across:
 *
 * 1. **No unsubscribe group.** SendGrid's ASM attached an unsubscribe link
 *    and a preference page by group id. Cloudflare has no equivalent, so a
 *    message sent this way carries neither. For a card somebody asked for
 *    that is defensible -- there is nothing to unsubscribe from -- but it is
 *    a decision rather than an oversight, and `List-Unsubscribe` would need
 *    somewhere to point before it could be added.
 * 2. **The display name is folded into the address.** SendGrid took a name
 *    and an address as separate fields; this takes one string, so the name
 *    goes in as `Name <address>`. That is the RFC 5322 form and should be
 *    read correctly, but it is the first thing to check on a real send.
 */

import { bytesToBase64 } from "../lib/base64";
import type { EmailAddress, EmailMessage } from "./send";

/**
 * The shape this project uses, declared here rather than taken from
 * `@cloudflare/workers-types`.
 *
 * The structured form below is newer than the raw-MIME `EmailMessage` the
 * published types describe, and Email Service is in beta. Depending on our
 * own narrow interface means a types release that has not caught up yet
 * cannot break the build, and the compiler still checks every call.
 */
export interface SendEmailBinding {
  send(message: BindingMessage): Promise<unknown>;
}

interface BindingAttachment {
  /** Base64, not bytes. */
  content: string;
  filename: string;
  type: string;
  disposition: "attachment";
}

export interface BindingMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: BindingAttachment[];
}

/** `Name <address>`, or the bare address when there is no name. */
export function formatAddress(address: EmailAddress): string {
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

export function buildBindingMessage(message: EmailMessage): BindingMessage {
  return {
    from: formatAddress(message.from),
    to: formatAddress(message.to),
    subject: message.subject,
    text: message.text,
    html: message.html,
    attachments: message.attachments?.map((attachment) => ({
      content: bytesToBase64(attachment.content),
      filename: attachment.filename,
      type: attachment.type,
      disposition: "attachment",
    })),
  };
}

/**
 * Sends one message. Throws if the binding rejects it, like the SendGrid path
 * does, so a caller cannot tell the two apart by how they fail.
 */
export async function sendViaBinding(
  binding: SendEmailBinding,
  message: EmailMessage,
): Promise<void> {
  try {
    await binding.send(buildBindingMessage(message));
  } catch (error) {
    // The binding throws rather than returning a status, so this is where the
    // reason is legible. Naming the transport matters while there are two:
    // "mail send failed" alone would leave a reader guessing which.
    throw new Error(`Cloudflare Email Service send failed: ${String(error)}`);
  }
}
