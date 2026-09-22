/**
 * Membership card verification (the legacy app's `verify_pass` route):
 * scanning a card's QR code opens `/verify-pass/:serial?signature=...`, which
 * confirms the card is genuine (see src/lib/passSignature.ts) and shows the
 * holder's *current* membership (src/member/passHolder.ts).
 *
 * Public: whoever checks a card at a table or a door should not have to sign
 * in first. The legacy app put it behind a login, which was friction rather
 * than protection -- any Google or Apple account would do. What stops a
 * stranger looking up an arbitrary card is the signature: without a real
 * card's QR code there is nothing to open.
 *
 * What a photographed card could reveal is narrowed instead. Its name and
 * "good through" date are printed on the card already. The one new thing a
 * live lookup adds is *why* a membership is not current, and "revoked" --
 * which expulsion resolves to as well -- is the Membership Committee's
 * decision, not something to show whoever holds an old photo. So everyone
 * gets valid or not; only a signed-in admin sees revoked as distinct from
 * lapsed, and the date a membership lapsed.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { formatShortDate } from "../lib/dateFormat";
import { recordOutcome } from "../lib/outcome";
import {
  passSignatureKeys,
  verifyPassSerialSignature,
} from "../lib/passSignature";
import type { Context } from "hono";
import type { Env } from "../index";
import { readSessionCookie, verifySessionToken } from "../auth/session";
import { Page } from "./layout";
import { lookupPassHolder, type PassHolder } from "./passHolder";

/**
 * What a public visitor is told about a card that is not current: that it is
 * genuine, and nothing about why. No date either -- a revoked membership has
 * none and a lapsed one does, so showing it would give the reason away.
 */
const NotCurrent: FC<{ holder: PassHolder }> = ({ holder }) => (
  <Page title="Card Verification">
    <h1>NOT A CURRENT MEMBERSHIP</h1>
    <p>This card is genuine, but it does not belong to a current membership.</p>
    {holder.name && <p style="font-size: 1.5rem">{holder.name}</p>}
  </Page>
);

export const VerificationResult: FC<{ holder: PassHolder; detail: boolean }> = ({ holder, detail }) =>
  !holder.active && !detail ? (
    <NotCurrent holder={holder} />
  ) : (
    <Page title="Card Verification">
      <h1>
        {holder.active
          ? "MEMBERSHIP VALID"
          : holder.revoked
            ? "MEMBERSHIP REVOKED"
            : "MEMBERSHIP EXPIRED"}
      </h1>
      {holder.revoked ? (
        // Said plainly rather than left as "expired": the card is genuine
        // either way, and somebody holding one up is owed an answer that does
        // not sound like it could be fixed by renewing.
        <p>This card is genuine, but this membership has been revoked.</p>
      ) : (
        !holder.active && (
          <p>This card is genuine, but its holder has no current membership.</p>
        )
      )}
      {holder.name && <p style="font-size: 1.5rem">{holder.name}</p>}
      {holder.expirationDate && (
        <p>
          {holder.active ? "Good through " : "Expired "}
          {formatShortDate(holder.expirationDate)}
        </p>
      )}
    </Page>
  );

/** Whether the visitor is signed in as an admin; checked against the database, as `requireAdmin` does. */
async function isSignedInAdmin(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const token = readSessionCookie(c);
  if (!token || !c.env.SESSION_SIGNING_KEY) return false;
  const session = await verifySessionToken(c.env.SESSION_SIGNING_KEY, token);
  if (!session) return false;
  const user = await c.env.DB.prepare("SELECT is_admin FROM users WHERE id = ?")
    .bind(session.userId)
    .first<{ is_admin: number }>();
  return user?.is_admin === 1;
}

const verifyPass = new Hono<{ Bindings: Env }>();

// A lookup about a person: never cached, and never indexed if a link to one
// is shared somewhere public.
verifyPass.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
});

verifyPass.get("/:serial", async (c) => {
  const serial = c.req.param("serial");
  // Whether the scanned card was minted by the previous site, which matters
  // most in the weeks after cutover: those QR codes are the oldest thing
  // still in circulation. New serials are `LV-` plus a UUID.
  const card = serial.startsWith("LV-") ? "current" : "legacy";
  const keyUsed = await verifyPassSerialSignature(
    passSignatureKeys(c.env),
    serial,
    c.req.query("signature"),
  );
  if (keyUsed === "previous") {
    // How a rotation ends: retire PASS_SIGNATURE_KEY_PREVIOUS once these stop
    // appearing, meaning every card still being scanned carries a signature
    // from the current key. No serial is logged -- a count over time is the
    // whole signal, and a serial identifies a member.
    console.warn(
      "/verify-pass: scanned card was signed with PASS_SIGNATURE_KEY_PREVIOUS",
    );
  }
  if (!keyUsed) {
    recordOutcome("pass.verified", { result: "bad_signature", card });
    return c.html(
      <Page title="Card Verification">
        <h1>Unable to verify signature!</h1>
      </Page>,
      403,
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const holder = await lookupPassHolder(c.env, serial, today);
  if (!holder) {
    recordOutcome("pass.verified", { result: "not_found", card, key: keyUsed });
    return c.html(
      <Page title="Card Verification">
        <h1>Card not found</h1>
      </Page>,
      404,
    );
  }
  recordOutcome("pass.verified", {
    result: holder.revoked ? "revoked" : holder.active ? "active" : "expired",
    card,
    key: keyUsed,
  });
  return c.html(<VerificationResult holder={holder} detail={await isSignedInAdmin(c)} />);
});

export default verifyPass;
