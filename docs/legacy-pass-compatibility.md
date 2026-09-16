# Legacy Wallet Pass Compatibility — Audit & Open Decisions

The migration plan's Phase 2.2 commits to carrying already-installed Apple
Wallet passes across cutover ("existing members keep receiving push
updates ... with no reinstall required"). This doc records what the legacy
`digital-membership` app actually embeds in those passes, where the current
`card-losverd-es` implementation doesn't line up with it yet, and the
decisions needed before the Phase 2.2 pass-state migration script can be
written.

Sources: the legacy app's `member_card/models/membership_card.py`,
`member_card/routes/passkit.py`, `member_card/passes/__init__.py`,
`member_card/utils.py`, `member_card/settings.py`, and a real production
pass (`lv_apple_pass-hogan.pkpass`).

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

* **`webServiceURL` → DNS-only cutover works for Apple.** Already
  `card.losverd.es/passkit`, and `src/index.ts` mounts PassKit at
  `/passkit`, so devices will reach the Worker with no pass changes.
* **Pass type / team identifiers** — `wrangler.toml` now sets them to the
  legacy values (previously `REPLACE_WITH_...` placeholders). Note the
  plan's Phase 4.7 example topic `pass.es.losverd.membership` is wrong;
  the real APNs topic is `pass.es.losverd.card`.
* **`passesUpdatedSince` tags.** Legacy `lastUpdated` is a Flask-serialized
  datetime (RFC 1123 string). After cutover, devices send that back; the
  new route's `Number(...)` yields `NaN`, which it already treats as "no
  filter" and returns every registered serial. Devices then refetch each
  pass once and pick up the new epoch-ms tag. Self-healing, one extra
  fetch per device, no change needed.

## 3. Gaps

### 3.1 Serial number → member lookup (blocks pass updates)

The new routes resolve `:serialNumber` via `members.member_id`, and
`registrations.serial_number` has a foreign key to `members(member_id)`.
Legacy serials are per-card UUID integers, so as of today every installed
pass would get **401 on its first post-cutover update fetch** (it still
displays, it just never updates again).

### 3.2 Auth token requires the legacy `SECRET_KEY` at export time

`members.auth_token` must equal the exact string embedded in the installed
pass, which is an HMAC of the card's raw token, not the raw token itself.
The export must compute
`urlsafe_b64encode(HMAC-SHA256(SECRET_KEY * 5, token.hex))` — Python's
`urlsafe_b64encode` keeps `=` padding, so a Node port needs
`digest("base64url")` **plus** re-added padding (plain `"base64"` differs
whenever the output contains `+`/`/`). `SECRET_KEY * 5` is Python string
repetition, then UTF-8 encoded. Cross-checked test vector: key
`"test-secret-key-abc" * 5`, message `0cd5ad745fbc40fd9569747fec277013` →
`x_td-tSCx3v0XBxKhhIrhJwPOBn6f7blXnFwhpYIzcM=`. This is compatible with Phase 2.3.1's decision to retire
`SECRET_KEY` from the *running* Worker: the key is only needed by the
one-shot export, and the resulting token strings are stored as opaque
values.

### 3.3 QR code verification signatures

Every existing QR code (Apple passes not yet refreshed, Google Wallet
passes, emailed card images) carries a `verify-pass` signature made with
`SECRET_KEY * 5`. Phase 2.3.1 plans a freshly generated
`PASS_SIGNATURE_KEY`, which would make **all existing QR codes fail
verification**. Also, `src/passkit/generator.ts` and `src/google/jwt.ts`
currently encode the bare serial as the barcode, not a signed URL, and
no `/verify-pass/...` route exists yet.

### 3.4 Google Wallet object ids

New `objectId()` is `{issuerId}.{memberId}`; legacy is
`{issuerId}.{uuid-string}`. Lower impact than Apple: Google passes aren't
device-polled, and the legacy app never updates objects via the Wallet API
(its `GooglePayApiClient` is only used by CLI commands that insert/patch
the pass *class*), so a changed
id just means post-cutover "Save to Google Wallet" links create a new
object rather than updating the old one.

## 4. Decisions needed

**D1 — How do legacy serials map to members?** (blocks 3.1 and the
Phase 2.2 export script)

* **(A) Recommended: one legacy card per member becomes `member_id`.** The
  export sets `members.member_id = str(card.serial_number.int)` and
  `auth_token` = the signed token (3.2), choosing per user the card with
  the most recent device registration, falling back to the most recent
  card. No schema or route changes — `upsertMemberFromOrder` already
  matches by email and preserves a pre-existing `member_id`. Cost: passes
  installed from a *non-chosen* older card stop updating (still display).
  Fits the plan's "simplicity over zero disruption" posture.
* **(B) Alias table.** Additive `legacy_pass_serials(serial_number PK,
  member_id FK, auth_token)`; routes resolve a serial via `members` then
  the alias table; `registrations.serial_number` FK would need to be
  relaxed (not additive — SQLite can't drop a FK in place) or registrations
  rewritten to the canonical id. Every installed pass keeps updating, at the
  cost of permanent extra lookup logic and a harder schema change.

**D2 — QR signature key.** (3.3)

* **(A) Recommended: set `PASS_SIGNATURE_KEY` to the legacy
  `SECRET_KEY * 5` bytes** (i.e. carry the value over for this one
  purpose), and port `/verify-pass/:uuid?signature=` with the same HMAC.
  Existing printed/emailed/Google QR codes keep verifying. Still decouples
  it from session signing, which was the actual point of Phase 2.3.1's
  split.
* **(B) Fresh key, as the plan says today.** Accept that every existing QR
  code fails verification until the member re-downloads their card.

**D3 — Google object ids** (3.4): recommend accepting the change (no
work), unless there's a reason to preserve Google pass continuity.
