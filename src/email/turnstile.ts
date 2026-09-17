/**
 * Cloudflare Turnstile server-side token verification -- the bot check on
 * the no-login email card form (src/member/email-card.tsx). Replaces the
 * legacy app's Google reCAPTCHA.
 *
 * The widget (`<div class="cf-turnstile">`) adds a `cf-turnstile-response`
 * field to its form; each token is single-use and must be verified here
 * against Siteverify before trusting the submission.
 */

export const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The form field the Turnstile widget puts its token in. */
export const TURNSTILE_RESPONSE_FIELD = "cf-turnstile-response";

/**
 * Whether `token` is a valid, unused Turnstile token. Fails closed: a
 * missing token or secret, a Siteverify error, or an unreadable response all
 * count as a failed check.
 */
export async function verifyTurnstileToken(
  secretKey: string | undefined,
  token: string | undefined,
  remoteIp?: string | null,
): Promise<boolean> {
  if (!secretKey || !token) {
    return false;
  }
  const body = new FormData();
  body.set("secret", secretKey);
  body.set("response", token);
  if (remoteIp) {
    body.set("remoteip", remoteIp);
  }
  try {
    const res = await fetch(TURNSTILE_SITEVERIFY_URL, { method: "POST", body });
    if (!res.ok) {
      console.error("Turnstile siteverify request failed", {
        status: res.status,
      });
      return false;
    }
    const result = await res.json<{
      success?: unknown;
      "error-codes"?: unknown;
    }>();
    if (result.success !== true) {
      console.warn("Turnstile token rejected", {
        errorCodes: result["error-codes"],
      });
      return false;
    }
    return true;
  } catch (err) {
    console.error("Turnstile siteverify request failed", {
      error: String(err),
    });
    return false;
  }
}
