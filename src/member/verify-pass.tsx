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
import type { FC, PropsWithChildren } from "hono/jsx";
import { formatShortDate } from "../lib/dateFormat";
import { verifyPassSerialSignature } from "../lib/passSignature";
import { requireAuth, type AuthEnv } from "../middleware/auth";
import { lookupPassHolder, type PassHolder } from "./passHolder";

const Page: FC<PropsWithChildren<{ title: string }>> = ({
  title,
  children,
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} | Los Verdes</title>
    </head>
    <body style="font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 28rem; padding: 0 1rem; text-align: center">
      {children}
    </body>
  </html>
);

export const VerificationResult: FC<{ holder: PassHolder }> = ({ holder }) => (
  <Page title="Card Verification">
    <h1>{holder.active ? "MEMBERSHIP VALID" : "MEMBERSHIP EXPIRED"}</h1>
    {!holder.active && (
      <p>This card is genuine, but its holder has no current membership.</p>
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
  const signatureValid = await verifyPassSerialSignature(
    c.env.PASS_SIGNATURE_KEY,
    serial,
    c.req.query("signature"),
  );
  if (!signatureValid) {
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
    return c.html(
      <Page title="Card Verification">
        <h1>Card not found</h1>
      </Page>,
      404,
    );
  }
  return c.html(<VerificationResult holder={holder} />);
});

export default verifyPass;
