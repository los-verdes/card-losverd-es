/**
 * Minimal SendGrid v3 Mail Send client (`POST /v3/mail/send`), used for
 * email card delivery (src/member/email-card.tsx). Mirrors the legacy app's
 * member_card/sendgrid.py: one recipient per message, optionally sent under
 * an ASM unsubscribe group -- but with inline HTML/text content and the card
 * artifacts as attachments rather than a hosted dynamic template.
 */

import { bytesToBase64 } from "../lib/base64";

export const SENDGRID_SEND_URL = "https://api.sendgrid.com/v3/mail/send";

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

/**
 * Sends one message. Throws (without retrying) if the API key is unset or
 * SendGrid doesn't accept the message.
 */
export async function sendEmail(
  apiKey: string | undefined,
  message: EmailMessage,
): Promise<void> {
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
