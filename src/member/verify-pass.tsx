/**
 * Membership card verification (the legacy app's `verify_pass` route):
 * scanning a card's QR code opens `/verify-pass/:serial?signature=...`, which
 * confirms the card is genuine (see src/lib/passSignature.ts) and shows the
 * holder's *current* membership (src/member/passHolder.ts).
 *
 * Behind `requireAuth`, as in the legacy app, so a photographed card doesn't
 * expose its holder's name and membership status to anyone.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { formatShortDate } from "../lib/dateFormat";
import { recordOutcome } from "../lib/outcome";
import {
  passSignatureKeys,
  verifyPassSerialSignature,
} from "../lib/passSignature";
import { requireAuth, type AuthEnv } from "../middleware/auth";
import { Page } from "./layout";
import { lookupPassHolder, type PassHolder } from "./passHolder";

export const VerificationResult: FC<{ holder: PassHolder }> = ({ holder }) => (
  <Page title="Card Verification">
    <h1>
      {holder.active
        ? "MEMBERSHIP VALID"
        : holder.revoked
          ? "MEMBERSHIP WITHDRAWN"
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

const verifyPass = new Hono<AuthEnv>();

verifyPass.get("/:serial", requireAuth, async (c) => {
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
  return c.html(<VerificationResult holder={holder} />);
});

export default verifyPass;
