/**
 * Stopping, and restarting, card emails to an address -- where a card
 * email's unsubscribe link lands.
 *
 * Needed because /email-card lets anyone ask for a card to be sent to any
 * member's address. Turnstile and the rate limits keep that from being a
 * flood; this is what lets the recipient make it stop entirely.
 *
 * The signed token (src/email/unsubscribeToken.ts) is the whole
 * authorisation: it proves its holder received mail at the address it names.
 * So there is no sign-in and no CSRF check. A cross-site form could only
 * submit a token its author already holds, and the one-click POST from a mail
 * client (RFC 8058) arrives from no page at all.
 *
 * GET never changes anything. Mail scanners open links to check them, and an
 * unsubscribe that happened on GET would unsubscribe people who never
 * clicked. The page asks for a button press, which is a POST.
 *
 * The record itself is the account's Email Service suppression list
 * (src/email/suppressions.ts), which the binding enforces at send time.
 */

import { Hono } from "hono";
import type { FC, PropsWithChildren } from "hono/jsx";
import { recordAuditEventBestEffort } from "../audit/log";
import {
  findSuppressions,
  isSuppressionListConfigured,
  suppressAddress,
  unsuppressAddress,
  type Suppression,
} from "../email/suppressions";
import { UNSUBSCRIBE_PATH, verifyUnsubscribeToken } from "../email/unsubscribeToken";
import type { Env } from "../index";
import { Page, SUPPORT_EMAIL } from "./layout";

const RESUME_PATH = `${UNSUBSCRIBE_PATH}/resume`;

const Message: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <Page title={title}>
    <h1>{title}</h1>
    {children}
  </Page>
);

const ButtonForm: FC<{ action: string; token: string; label: string }> = ({ action, token, label }) => (
  <form method="post" action={`${action}?token=${encodeURIComponent(token)}`}>
    <button type="submit">{label}</button>
  </form>
);

const BadLink = () => (
  <Message title="That link doesn't work">
    <p>
      It may have been cut short when it was copied. Try the link in the email again, or contact{" "}
      <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
    </p>
  </Message>
);

const Unavailable = () => (
  <Message title="Please try again later">
    <p>
      We couldn&#39;t update your email preferences just now. Nothing has changed. Try again later, or contact{" "}
      <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
    </p>
  </Message>
);

/**
 * What the page says about an address already on the list. A row Cloudflare
 * added itself -- a bounce or a spam report -- can't be lifted from here, and
 * saying so is better than a "resume" button that does nothing.
 */
const Stopped: FC<{ email: string; token: string; rows: Suppression[] }> = ({ email, token, rows }) => (
  <Message title="Card emails stopped">
    <p>
      <strong>{email}</strong> won&#39;t receive membership card emails from Los Verdes, including ones somebody
      requests for it.
    </p>
    {rows.some((row) => row.read_only) ? (
      <p>
        Our mail service has also stopped delivering to this address after a message bounced or was reported as
        spam. To lift that, contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    ) : (
      <>
        <p>Changed your mind?</p>
        <ButtonForm action={RESUME_PATH} token={token} label="Start card emails again" />
      </>
    )}
  </Message>
);

/** The token from the query, and the address it names (null if it is not valid). */
async function addressFrom(c: { env: Env; req: { query(name: string): string | undefined } }) {
  const token = c.req.query("token") ?? "";
  const email = await verifyUnsubscribeToken(c.env.SESSION_SIGNING_KEY, token);
  return { token, email };
}

const unsubscribe = new Hono<{ Bindings: Env }>();

unsubscribe.get("/", async (c) => {
  const { token, email } = await addressFrom(c);
  if (!email) return c.html(<BadLink />, 400);
  if (!isSuppressionListConfigured(c.env)) return c.html(<Unavailable />, 503);

  let rows: Suppression[];
  try {
    rows = await findSuppressions(c.env, email);
  } catch (error) {
    console.error("Unsubscribe: could not read the suppression list", { error: String(error) });
    return c.html(<Unavailable />, 503);
  }
  if (rows.length > 0) return c.html(<Stopped email={email} token={token} rows={rows} />);

  return c.html(
    <Message title="Stop card emails?">
      <p>
        Stop Los Verdes sending membership card emails to <strong>{email}</strong>? That includes ones somebody
        else requests for this address. Your membership isn&#39;t affected, and your card stays available when you
        sign in.
      </p>
      <ButtonForm action={UNSUBSCRIBE_PATH} token={token} label="Stop card emails" />
    </Message>,
  );
});

unsubscribe.post("/", async (c) => {
  const { token, email } = await addressFrom(c);
  if (!email) return c.html(<BadLink />, 400);
  if (!isSuppressionListConfigured(c.env)) return c.html(<Unavailable />, 503);

  // A mail client's one-click unsubscribe says so in the body (RFC 8058);
  // the button on the page above does not. Only the audit line differs.
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const oneClick = form["List-Unsubscribe"] === "One-Click";

  let rows: Suppression[];
  try {
    await suppressAddress(c.env, email, "Unsubscribed from a card email");
    rows = await findSuppressions(c.env, email);
  } catch (error) {
    console.error("Unsubscribe: could not add to the suppression list", { error: String(error) });
    return c.html(<Unavailable />, 503);
  }
  await recordAuditEventBestEffort(c.env, {
    action: "email.unsubscribed",
    subjectEmail: email,
    // The person themselves: the token shows they receive mail there.
    actorEmail: email,
    detail: oneClick
      ? "With their mail client's unsubscribe button"
      : "From the unsubscribe link in a card email",
  });
  return c.html(<Stopped email={email} token={token} rows={rows} />);
});

unsubscribe.post("/resume", async (c) => {
  const { token, email } = await addressFrom(c);
  if (!email) return c.html(<BadLink />, 400);
  if (!isSuppressionListConfigured(c.env)) return c.html(<Unavailable />, 503);

  let remaining: Suppression[];
  try {
    await unsuppressAddress(c.env, email);
    remaining = await findSuppressions(c.env, email);
  } catch (error) {
    console.error("Unsubscribe: could not remove from the suppression list", { error: String(error) });
    return c.html(<Unavailable />, 503);
  }
  await recordAuditEventBestEffort(c.env, {
    action: "email.resubscribed",
    subjectEmail: email,
    actorEmail: email,
    detail: "From the unsubscribe page",
  });
  // What is left is a row Cloudflare added itself, which says so.
  if (remaining.length > 0) {
    return c.html(<Stopped email={email} token={token} rows={remaining} />);
  }
  return c.html(
    <Message title="Card emails back on">
      <p>
        <strong>{email}</strong> can receive membership card emails from Los Verdes again.
      </p>
    </Message>,
  );
});

export default unsubscribe;
