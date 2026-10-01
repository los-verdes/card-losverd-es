# Where Membership Card Information Comes From

This document defines how membership status is derived and displayed across digital membership cards for Los Verdes. The
primary audiences are:

- **The Merch Team** (`merchteam@losverdesatx.org`): Store administrators and primary data-source managers.
- **The Membership Committee** (`mc@losverdesatx.org`): Stewards of member standing, code of conduct enforcement, and
  disciplinary processes.

Deciding membership card attributes is functionally identical to establishing active membership status. This document
specifies the current implementation and outlines open policy choices in **Section 9**.

The last section, [Decisions worth confirming](#9-decisions-worth-confirming), gathers the places where the app had to
pick a rule and where a different policy would be equally easy to implement. This section in particular is seeking
feedback from any interested folks.

---

## 1. Summary

- **Source of truth:** Membership derives from membership product orders placed on the Los Verdes store
  (`store.losverdesatx.org/membership/`).
  - All counted membership orders for an individual resolve into a single aggregate membership.
  - Members are identified uniquely by email address (order email by default, unless manually re-attributed).
  - A membership remains active until `<most recent counted order date> + 365 days` (unless revoked).
- **Card application behavior:**
  - Card attributes reflect this aggregate order history.
  - "Member since" displays the earliest qualifying order date (unless overridden).
  - Only orders containing explicitly configured membership SKUs are recorded.

---

## 2. System Architecture

The application receives order events via BigCommerce webhooks on order updates (`POST /bigcommerce/order-webhook`) and
runs periodic resyncs to catch missed deliveries.

Qualifying orders are grouped by member email. A single calculation engine (`refreshMemberFromOrders()` in
`src/bigcommerce/sync.ts`) recalculates the full membership state whenever an order updates, a scheduled sync executes,
or an order is manually re-attributed.

---

## 3. Order Processing & Synchronization

### Membership Order Criteria

An order counts as a membership order when a line item matches an entry in `MEMBERSHIP_SKUS`: `LOSV-MEM-0001` (physical
pack with merchandise) or `LOSV-DIGI-5000` (digital-only). Both SKUs generate identical memberships and cards.
Non-matching orders are ignored.

### One Membership per Order Constraint

The current schema expects **one membership product per order**. The storefront enforces this constraint at checkout.

The ingestion pipeline records `membership_orders.membership_units`. Any active order containing multiple membership
units is flagged on the admin report under "More than one membership" until addressed or expired.

### Authoritative Source

BigCommerce is authoritative; the app maintains a downstream replica. Two fields originate within the application rather
than the store:

- `membership_orders.member_email`: Attribution override (never overwritten by syncs).
- `membership_orders.missing_since`: Flag set when an order ceases to return from the store API.

### Sync Strategy

- **Re-reading is idempotent:** Processing an order overwrites the local row by ID; multiple passes produce no duplicate
  state.
- **Direct overwrite:** Ingested store fields replace local copies rather than merging.
- **Routine reconciliation:** A routine sync runs every six hours for recent changes, and a full-store sweep
  (`sync_subscriptions_etl`) runs weekly early Sunday morning.
- **Missing orders:** If an order disappears from BigCommerce, it is flagged under "Missing from BigCommerce" rather
  than deleted, preserving current cards.
- **Manual resync:** Admins can trigger a manual fetch for any single order via the **Re-read from BigCommerce** button
  without notifying the member.

### Known Edge Cases

- **Archived orders:** Archiving (soft deleting) an order in BigCommerce does not remove or flag it locally; it
  continues counting toward membership.
- **Unlisted SKUs:** Orders using an unlisted SKU will not issue cards or trigger reports. Adding new membership tiers
  requires updating `MEMBERSHIP_SKUS` in code.
- **MiniBC renewals:** Recurring subscriptions managed through MiniBC do not fire BigCommerce webhooks unless configured
  to generate a standard order.

---

## 4\. Card Fields & Verification

All formats (Apple Wallet, Google Wallet, card images, and QR verification pages) resolve through a shared query
(`MEMBER_SELECT` in `src/member/artifacts.ts`).

### Field Comparison

- **Holder Name:** Available on Apple Wallet (front), Google Wallet (front), Emailed Card Image (front). Sourced from
  display name override, else latest order billing name (`deriveMembershipState()`).
- **Member Since:** Available on Apple Wallet (front), Google Wallet (front), Emailed Card Image (front). Sourced from
  override table date, else earliest qualifying order (`formatMonthYear()`).
- **Good Through:** Available on Apple Wallet (front), Google Wallet (front), Emailed Card Image (front). Sourced from
  furthest single-order expiry date (`formatShortDate()`).
- **Card Number:** Apple Wallet (back), Google Wallet (QR alt text), Emailed Card Image (below QR). Immutable UUID
  format: `LV-<uuid>` (`members.member_id`).
- **Status Note:** Apple Wallet (back, if lapsed), Google Wallet (wallet state), Emailed Card Image (omitted). Derived
  at request time (`effectiveStatus()`).

### Field Details

- **Holder's Name:** Defaults to the first and last billing name on the most recent counted order. A member or an admin
  may set a custom display name (up to 64 characters via `member_display_names`). A member who updates their billing
  name at checkout will see it reflected on their next membership purchase; however, an attributed gift order retains
  the purchaser’s billing name, which can result in a gifted card displaying the buyer's name (see Section 8).
- **Good Through:** Calculated as `order_date + 365 days` per qualifying order. The displayed date is the latest among
  all qualifying orders. Terms do not accumulate consecutively.
- **Card Number & QR Code:** Uses a persistent UUID generated upon initial record creation. The card number is not
  derived from the store customer ID because guest checkouts share ID 0 and gifted orders retain the buyer’s customer
  ID. The QR code encodes a signed URL to `src/member/verify-pass.tsx`. Public scans return binary validity ("Valid" or
  "Not a current membership"); specific lapse or revocation states require signed-in admin access.

### Card Themes

- **Season themes:** Scarf artwork and color palettes exist for 2020, 2021, 2022, and 2023; fallback is `'classic'`.
- **Eligible themes:** Years of purchased memberships, "Member Since" year, active Slack subgroup channels (e.g.
  `#los-pringles`), and `'classic'`.
- **Subgroup validity:** Active while the member's email remains in the Slack channel; leaving reverts to default.
- **Persistence:** Stored in `member_card_themes` to preserve choices across sync rebuilds; controlled via
  `CARD_THEME_CHOICE` setting.

---

## 5\. Membership Qualification Rules

A person holds current membership if their furthest qualifying order expiry is today or later and the record has no
active revocation or expulsion flag (`isMembershipCurrent()`).

### Qualifying Statuses

Orders must carry an explicit paid status (`PAID_BIGCOMMERCE_STATUSES`) to grant membership:

- **Qualifying:** `Awaiting Fulfillment`, `Awaiting Shipment`, `Partially Shipped`, `Shipped`, `Completed`.
- **Non-Qualifying:** `Incomplete`, `Pending`, `Awaiting Payment`, `Refunded`, `Partially Refunded`, `Cancelled`,
  `Declined`, `Disputed`.

*Note on partial refunds:* Partially Refunded orders do not grant membership because the system cannot verify which line
item was refunded. This policy should be monitored, as it risks revoking membership for multi-item orders where only
merchandise was refunded.

### Revocations & Expulsions

Disciplinary actions supersede order status and require Membership Committee execution:

- **Revocation (`revoked_cards`):** Invalidates a specific card record without deleting underlying order data.
- **Expulsion (`expelled_people`):** Disables member login and blocks future cards issued to that email address.

---

## 6\. "Member Since" Precedence

When determining the "Member Since" date, the system evaluates sources in the following precedence order:

1. `Manual Admin Override` (`member_since_overrides`, `source = 'manual'`)
2. `Legacy Import Override` (`member_since_overrides`, `source = 'legacy_postgres'`)
3. `Earliest Counted Order` (`members.member_since`)

*(Implemented via `COALESCE` in `src/member/artifacts.ts`).*

- **Order-derived date:** The timestamp of the earliest qualifying order on file.
- **Legacy import:** Historical dates imported from Squarespace/Postgres records (pre-February 2023).
- **Manual override:** Administrative entry via the admin dashboard, requiring an audit note. An override replaces any
  prior value.

---

## 7\. Aggregation & Lifecycle

1. Ingest all qualifying orders matching the email address.
2. Reduce rows to card attributes via `deriveMembershipState()`.
3. Update or create the member record in `members`.

- **Decoupled data models:** Orders remain immutable historical logs; memberships are computed snapshots.
- **Non-accumulating terms:** Expirations do not stack. Renewing 30 days prior to expiration sets the new term to
  `purchase_date + 365 days`, shortening the overall coverage window by 30 days.
- **Persistent identities:** Lapsed members retain their UUID (`member_id`), push tokens, and pass configurations
  indefinitely with an empty expiry. A subsequent renewal re-activates the existing card.

---

## 8\. Gifts & Order Re-Attribution

Orders maintain two email fields:

- `order_email`: The billing email on the transaction (immutable).
- `member_email`: The address to which membership entitlement is assigned.

Re-attributing an order (`attributeOrder()` in `src/admin/attribution.ts`) updates `member_email`, records an entry in
`membership_order_attributions`, recalculates the membership records for both donor and recipient, and pushes updates to
installed wallet passes. The `member_email` field is protected against automated overwrite during routine BigCommerce
sync passes.

---

## 9\. Policy Decisions & Implementation Options

1. **When does membership activate?**
   - Current: Immediately upon payment (`Awaiting Fulfillment`).
   - Alternatives: Delay activation until physical fulfillment (`Shipped`).
2. **Do refunds revoke membership retroactively?**
   - Current: Yes; order stops counting immediately upon refund status.
   - Alternatives: Retain active status through the season for partial refunds.
3. **How should early renewals extend terms?**
   - Current: 365 days from the purchase date (losing overlapping days).
   - Alternatives: Add 365 days to the previous `expires_on` date.
4. **Does "Member Since" represent continuous tenure?**
   - Current: No; displays the earliest documented join date regardless of lapses.
   - Alternatives: Reset date following a lapse; indicate broken tenures.
5. **How should conflicting "Member Since" dates resolve?**
   - Current: Overrides always win, even if later than earliest counted order.
   - Alternatives: Automatically display whichever date is earlier.
6. **What restrictions apply to display names?**
   - Current: Unrestricted free-text up to 64 characters.
   - Alternatives: Add profanity filters, require admin approval, or lock to billing names.
7. **Is email address the proper member identifier?**
   - Current: Yes; one email equals one membership entity.
   - Alternatives: Support multi-email linking or separate member accounts.
8. **How should sanctions be structured?**
   - Current: Binary revocation (card) and expulsion (email).
   - Alternatives: Introduce temporary suspensions, disciplinary tiers, or appeal logs.
9. **Should archived orders confer membership?**
   - Current: Yes; archived orders continue counting.
   - Alternatives: Treat archived orders as cancelled or route to an admin review queue.
10. **Should a membership that renews automatically stay current while its renewal is being charged?**
    - Current: No grace period; runs strictly 365 days, which can cause a 1-day lapse during leap years (Feb 29\) or
      temporary lapses during failed payment retries.
    - Alternatives: Introduce a multi-day grace window for active subscriptions, balanced against conferring unearned
      access if renewal fails.

---

## 10\. Audit Logging

Administrative interventions are permanently recorded in the audit log (`/admin/audit`).

- **Logged actions:** Card name modifications, "Member since" overrides, order re-attributions, card email dispatches,
  revocations, and expulsions.
- **Entry schema:** Timestamp, target user, actor (admin username, `site automation`, or `command line`), action type,
  and previous/new values.
- **Data retention:** Audit records are immutable and persist when state tables are modified or cleared. Administrative
  CSV exports of the audit log generate an audit event noting actor and exported row count.
- **Excluded events:** High-frequency, deterministic automated events (standard order webhook ingestion, daily scheduled
  sync runs, pass re-renders) are omitted.

---

## Appendix: Legacy Orders (Pre-February 2023\)

Orders imported from Squarespace (prior to February 2023\) use static, precomputed verdicts stored in
`membership_orders.frozen_counts`.

- **Qualification rule:** Counted unless status was explicitly `canceled`, `cancelled`, `refunded`, or `declined`.
  (Squarespace marked paid, unshipped orders as `PENDING`, whereas BigCommerce uses `Pending` for unpaid transactions).
- **Scope:** Legacy orders establish historical "Member since" dates and resolve physical legacy card QR scans via
  `legacy_membership_cards`. They cannot confer active membership today.
