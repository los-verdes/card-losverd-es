/**
 * Minimal SendGrid v3 Mail Send client (`POST /v3/mail/send`). Mirrors the
 * legacy app's `member_card/sendgrid.py`: one recipient per message,
 * optionally sent under an ASM unsubscribe group -- but with inline HTML/text
 * content and the card artifacts as attachments rather than a hosted dynamic
 * template.
 *
 * A transport and nothing more. Whether a message may be sent at all is
 * decided in ./send.ts, which is the only thing that should call this, and
 * which will stop doing so once every environment has the Cloudflare Email
 * Service binding instead (#244). At that point this file goes.
 */

import { bytesToBase64 } from "../lib/base64";
import type { EmailMessage } from "./send";

export const SENDGRID_SEND_URL = "https://api.sendgrid.com/v3/mail/send";

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

/** Sends one message. Throws if SendGrid doesn't accept it. */
export async function sendViaSendGrid(
  apiKey: string,
  message: EmailMessage,
): Promise<void> {
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
