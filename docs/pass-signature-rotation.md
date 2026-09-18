# Rotating `PASS_SIGNATURE_KEY`

`PASS_SIGNATURE_KEY` signs the QR code on every membership card:
`/verify-pass/:serial?signature=...`, where the signature is
`urlsafe_b64encode(HMAC-SHA256(key, serial))` (`src/lib/passSignature.ts`).

Rotating it is awkward for a reason worth stating plainly: a QR code is not a
session. Once a card is in a member's Apple Wallet, in their Google Wallet, or
sitting in an emailed PNG, that image carries a signature made with whatever
key was current the day it was issued, and we cannot reach out and change it.
Changing the key without preparation would make every card already in
circulation fail verification at the gate.

The value in use today is inherited: it is the legacy app's key bytes
(`SECRET_KEY * 5`), kept so that cards issued by the Python app keep working
(`docs/legacy-pass-compatibility.md`, D2). It has existed for years, which is
itself a reason to want a rotation path.

## How rotation works

Verification accepts two keys; signing only ever uses one.

- `PASS_SIGNATURE_KEY` — the current key. Every new signature uses it.
- `PASS_SIGNATURE_KEY_PREVIOUS` — set only during a rotation. Accepted at
  `/verify-pass`, never used to sign.

No key identifier is carried in the URL, and none can be: the codes already in
the world were issued without one. Instead, verification tries the current key
and then, if that fails, the previous one. Two HMACs on a failing scan is not a
cost worth engineering around.

A card is re-signed with the current key whenever its artifacts are rebuilt,
which happens lazily off `members.last_updated_at` (`src/member/artifacts.ts`).
So members re-issue themselves over time, as memberships renew and passes
update.

## Ending the window

Not on a timer. Every scan that verifies against the retired key logs:

```
/verify-pass: scanned card was signed with PASS_SIGNATURE_KEY_PREVIOUS
```

That line is the whole signal. Query it in Workers Logs; when it stops
appearing over a period that covers normal match-day scanning, the cards still
being presented have all been re-signed, and the retired key can go. A member
who never renews and never opens the site may hold an old card indefinitely, so
the judgement is "has this gone quiet", not "has it reached zero". No serial is
logged: the count is the signal, and a serial identifies a member.

## Steps

1. Generate a new key and store it in 1Password as `PASS_SIGNATURE_KEY_PREVIOUS`
   — the *current* value, moved. Add the newly generated value as
   `PASS_SIGNATURE_KEY`, replacing it.

   ```bash
   openssl rand -hex 32
   ```

2. Push both, so verification learns the old key at the same moment signing
   switches to the new one:

   ```bash
   just secrets-push staging PASS_SIGNATURE_KEY PASS_SIGNATURE_KEY_PREVIOUS
   just secrets-status staging
   ```

   Both keys reach the Worker in a single deploy (`wrangler secret bulk`),
   which is what keeps the switch seamless. Do staging first and scan a card.

3. Let cards re-issue. To hurry it along, touch `last_updated_at` so artifacts
   rebuild on next fetch. Note this also prompts Apple Wallet passes to update,
   and that it does **not** email anyone — card emails are only ever sent from
   a member's own request, an attribution, or a new order
   (`src/email/card.tsx`).

4. Watch the log line above until it goes quiet.

5. Finish the rotation by removing `PASS_SIGNATURE_KEY_PREVIOUS` from the
   1Password item and from Cloudflare:

   ```bash
   npx wrangler secret delete PASS_SIGNATURE_KEY_PREVIOUS --env staging
   ```

   Any card still carrying an old signature now fails verification and its
   holder needs a fresh one, which they can get themselves at `/email-card`.

## Not for a compromised key

The procedure above assumes a routine rotation, where old signatures staying
valid for a while is acceptable. If the key is believed to have leaked, the
window is the problem rather than the point: set `PASS_SIGNATURE_KEY` to the
new value and do **not** set `PASS_SIGNATURE_KEY_PREVIOUS` at all. Every card
in circulation stops verifying immediately, which is the intended outcome, and
members re-issue via `/email-card`.
