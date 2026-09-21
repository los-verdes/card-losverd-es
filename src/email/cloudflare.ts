/**
 * Sending through Cloudflare Email Service's Worker binding (#244).
 *
 * The binding is the reason for it: there is no API key, so there is no
 * outbound credential to rotate, leak or audit. It is declared in
 * `wrangler.toml` as a `send_email` binding named EMAIL, and the sending
 * domain has to be onboarded in the same Cloudflare account.
 *
 * Two things worth knowing about what goes out:
 *
 * 1. **No unsubscribe link.** The previous site sent through SendGrid under an
 *    unsubscribe group, which added a link and a preference page. There is no
 *    equivalent here, so a message carries neither. For a card somebody asked
 *    for that is defensible -- there is nothing to unsubscribe from -- but it
 *    is a decision rather than an oversight, and `List-Unsubscribe` would need
 *    somewhere to point before it could be added.
 * 2. **Addresses go in structured, never as `Name <address>`.** The binding
 *    accepts `{ email, name }` for `from` and `to`, and that is what it gets.
 *    Folding the name into one string was tried first and failed on the first
 *    real send -- "Invalid email address: Invalid email user" -- because
 *    staging's name, `Los Verdes (verde-bot staging)`, carries parentheses,
 *    which are comment syntax in an address unless the name is quoted. Handing
 *    the parts over separately leaves nothing to quote or parse.
 *    https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
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

/** The binding's own address shape; a bare string is also accepted. */
export interface BindingAddress {
  email: string;
  name?: string;
}

export interface BindingMessage {
  from: BindingAddress;
  to: BindingAddress;
  subject: string;
  text: string;
  html: string;
  attachments?: BindingAttachment[];
}

/** The address as the binding takes it, with `name` left off when there is none. */
export function toBindingAddress(address: EmailAddress): BindingAddress {
  return address.name ? { email: address.email, name: address.name } : { email: address.email };
}

export function buildBindingMessage(message: EmailMessage): BindingMessage {
  return {
    from: toBindingAddress(message.from),
    to: toBindingAddress(message.to),
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
 * Sends one message. Throws if the binding rejects it, with the service named
 * in the error, so a log line says where the failure came from.
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
