# Legacy Wallet Pass Compatibility — Audit & Decisions

The migration plan's Phase 2.2 originally committed to carrying
already-installed Apple Wallet passes across the cutover ("existing members keep
receiving push updates ... with no reinstall required"). This doc records
what the legacy `digital-membership` app actually embeds in those passes,
where the new `card-losverd-es` implementation differs, and the decisions
made about each gap (§4). **Outcome: installed passes are not migrated.**
The only legacy pass data carried forward is what's needed to keep old QR
codes verifiable.

Sources: the legacy app's `member_card/models/membership_card.py`,
`member_card/routes/passkit.py`, `member_card/passes/__init__.py`,
`member_card/utils.py`, `member_card/settings.py`, and a real pass issued by
the legacy production app.

## 1. What installed passes contain

| Field | Legacy value | Where it comes from |
| :--- | :--- | :--- |
| `webServiceURL` | `https://card.losverd.es/passkit` | `f"{BASE_URL}/passkit"`, stored per card |
| `passTypeIdentifier` | `pass.es.losverd.card` | `APPLE_DEVELOPER_PASS_TYPE_ID` |
| `teamIdentifier` | `KJHZP635V9` | `APPLE_DEVELOPER_TEAM_ID` |
| `serialNumber` | `str(card.serial_number.int)` — a 128-bit **integer** rendering of a per-card UUID, e.g. `17060213257243853049731934763545489427` | `MembershipCard.apple_pass_serial_number` |
| `authenticationToken` | `urlsafe_b64encode(HMAC-SHA256(key=SECRET_KEY * 5, msg=card.authentication_token.hex))` — URL-safe alphabet, **with** `=` padding | `sign(membership_card.authentication_token_hex)` |
| `barcode.message` | `Content: https://card.losverd.es/verify-pass/{uuid}?signature={urlsafe_b64encode(HMAC-SHA256(SECRET_KEY * 5, str(uuid)))}` | `get_or_create_membership_card` (the `Content: ` prefix is a legacy quirk) |
| Google Wallet object id | `{GOOGLE_PAY_ISSUER_ID}.{str(uuid)}` (hyphenated UUID string, not the int) | `GooglePayPassObject.object_id` |

**Cards are per membership period, not per member.** `get_or_create_membership_card`
keys on `(user_id, member_since, member_until)`, so every renewal mints a
new `membership_cards` row with a new serial *and* a new
`authentication_token`. A member can have several installed-pass
identities across devices/years. Legacy device registrations are
one-card-per-device (`apple_device_registration.device_library_identifier`
is unique, with a single `membership_card_id`).

## 2. What already lines up

* **`webServiceURL`.** Already `card.losverd.es/passkit`, and `src/index.ts`
  mounts PassKit at `/passkit`, so legacy passes' (never-working) update
  requests reach this Worker; they just don't match a member
  (§3.1).
* **Pass type / team identifiers** — `wrangler.toml` now sets them to the
  legacy values (previously `REPLACE_WITH_...` placeholders). Note the
  plan's Phase 4.7 example topic `pass.es.losverd.membership` is wrong;
  the real APNs topic is `pass.es.losverd.card`.
* **`passesUpdatedSince` tags.** Legacy-format (non-numeric) tags are
  already handled safely: the new route's `Number(...)` yields `NaN`, which
  it treats as "no filter" rather than erroring.

## 3. Gaps

### 3.1 Serial numbers don't match — but legacy pass updates never worked

The new routes resolve `:serialNumber` via `members.member_id`, and
`registrations.serial_number` has a foreign key to `members(member_id)`.
Legacy serials are per-card UUID integers, so installed legacy passes
don't match anything here.

That turns out not to matter much, because **the legacy pass update flow
never worked**, so no installed pass has ever received an update. Members
already get a new pass each year. Evidence from the legacy code:

* No APNs client exists anywhere in `member_card/` — nothing ever pushed an
  update to a device.
* `get_serial_numbers_for_device_passes` compares a `datetime` to the
  `passesUpdatedSince` query-string value (`time_updated >= passes_updated_since`),
  which raises `TypeError` → 500 whenever a device sends that parameter. The
  code itself records a real device log of this (2022): *"Get serial #s
  task ... encountered error: Unexpected response code 500"*.
* `apple_device_registration.device_library_identifier` is `UNIQUE`, so a
  device can't register a second (renewed) card.

### 3.2 Pass auth tokens (moot after D1)

Installed passes authenticate with
`urlsafe_b64encode(HMAC-SHA256(SECRET_KEY * 5, card.authentication_token.hex))`.
With no pass-state migration (D1), nothing needs to reproduce these. Kept
for reference, since the **same scheme signs QR codes** (§3.3): Python's
`urlsafe_b64encode` keeps `=` padding, so a Node port needs
`digest("base64url")` **plus** re-added padding (plain `"base64"` differs
whenever the output contains `+`/`/`). `SECRET_KEY * 5` is Python string
repetition, then UTF-8 encoded. Cross-checked test vector: key
`"test-secret-key-abc" * 5`, message `0cd5ad745fbc40fd9569747fec277013` →
`x_td-tSCx3v0XBxKhhIrhJwPOBn6f7blXnFwhpYIzcM=`.

### 3.3 QR code verification

Every existing QR code (installed Apple passes, Google Wallet passes,
emailed card images) encodes
`/verify-pass/{uuid}?signature=urlsafe_b64encode(HMAC-SHA256(SECRET_KEY * 5, str(uuid)))`.
Legacy `verify_pass` (`member_card/app.py`, `@login_required`) verifies the
signature, then **looks the card up by UUID** to show whose card it is and
whether it's expired (`member_until < now` → "CARD EXPIRED (but valid)!").

New passes (`src/passkit/generator.ts`, `src/google/jwt.ts`) and card images
encode the same signed `/verify-pass` URL, and `/verify-pass` resolves both
new serials and legacy card UUIDs (`legacy_membership_cards`), so a QR code
from either site verifies. Production's `PASS_SIGNATURE_KEY` holds the
legacy `SECRET_KEY * 5` for exactly that reason (D2).

### 3.4 Google Wallet object ids

New `objectId()` is `{issuerId}.{memberId}`; legacy is
`{issuerId}.{uuid-string}`. The legacy app never updates Google objects
(its `GooglePayApiClient` is only used by CLI commands that insert/patch
the pass *class*), so nothing is lost if the id changes.

## 4. Decisions (resolved 2026-09-16)

**D1 — Legacy serial mapping: none.** Legacy pass updates never worked
(§3.1), so installed passes simply keep displaying until the member gets a
new pass, which is the status quo. Consequence: the plan's Phase 2.2
**pass-state migration (`auth_token` / `devices` / `registrations`) is
dropped**, since it only existed to keep installed passes updating. Passes
issued by this stack do receive updates (Phase 4.7 APNs), confirmed on a real
device against production.

**D2 — QR signature key: reuse the legacy key.** `PASS_SIGNATURE_KEY` is set
to the legacy `SECRET_KEY * 5` value, so existing QR codes keep verifying.
It's still a separate secret from `SESSION_SIGNING_KEY`, which was the
point of Phase 2.3.1's split. Rotation goes through an overlap window; see `docs/pass-signature-rotation.md`.
To make old codes *useful* (not just signature-valid), the port needs the
legacy card lookup (§3.3):

* The one-time Postgres export that already has to happen for the
  `member_since` backfill also exports legacy cards —
  `(serial_number uuid, user email, member_since, member_until)` — into an
  additive read-only D1 table (e.g. `legacy_membership_cards`).
* `/verify-pass/:serial?signature=` verifies with `PASS_SIGNATURE_KEY`,
  then resolves the serial against `legacy_membership_cards` (and, once new
  passes carry signed URLs, against `members`).
* New passes should also switch from a bare-serial barcode to a signed
  verify URL, using the same key.

**D3 — Google object ids: accept the change.** Google Wallet object updates
don't exist today; adding them for new-stack passes is a tracked
enhancement.
