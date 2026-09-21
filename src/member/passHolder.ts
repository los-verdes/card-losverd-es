import type { Env } from "../index";
import { cardNameText, isMembershipCurrent, type MemberRecord } from "./artifacts";

export interface PassHolder {
  name: string | null;
  /** ISO8601 `YYYY-MM-DD`, or null if unknown. */
  expirationDate: string | null;
  active: boolean;
  /**
   * Revoked rather than lapsed. Distinguished because the card is genuine
   * either way, and somebody holding it up at a gate is owed a straight
   * answer about which it is -- a card that says only "expired" invites an
   * argument about renewing.
   */
  revoked: boolean;
}

/**
 * Resolves a membership card serial -- a legacy card UUID
 * (`legacy_membership_cards`) or a new-stack `members.member_id` -- to the
 * holder's *current* membership, not the dates printed on that particular
 * card: legacy cards were minted per membership period, so an old card's own
 * dates say nothing about a member who has since renewed. Returns `null` for
 * an unknown serial.
 */
export async function lookupPassHolder(
  env: Env,
  serial: string,
  today: string,
): Promise<PassHolder | null> {
  const legacyCard = await env.DB.prepare(
    "SELECT email, full_name, member_until FROM legacy_membership_cards WHERE serial_number = ?",
  )
    .bind(serial)
    .first<{
      email: string;
      full_name: string | null;
      member_until: string | null;
    }>();
  const email =
    legacyCard?.email ??
    (
      await env.DB.prepare("SELECT email FROM members WHERE member_id = ?")
        .bind(serial)
        .first<{ email: string }>()
    )?.email;
  if (!email) {
    return null;
  }

  const member = await env.DB.prepare(
    // Joined rather than selected from `members` alone: the verification page
    // must show the same name as the card it is verifying,
    // and must not call a revoked membership merely expired -- which
    // a ban produces as surely as a revoked card does.
    `SELECT m.first_name, m.last_name, m.expiration_date, d.display_name,
            COALESCE(r.member_id, b.email) AS revoked_card
       FROM members m
            LEFT JOIN member_display_names d ON d.email = m.email
            LEFT JOIN revoked_cards r ON r.member_id = m.member_id
            LEFT JOIN banned_people b ON b.email = m.email
      WHERE m.email = ?`,
  )
    .bind(email)
    .first<
      Pick<
        MemberRecord,
        | "first_name"
        | "last_name"
        | "expiration_date"
        | "display_name"
      > & { revoked_card: string | null }
    >();
  if (!member) {
    // A legacy card holder BigCommerce sync never created a row for (e.g. a
    // long-lapsed Squarespace-era member): all we know is that card's dates.
    const expirationDate = legacyCard!.member_until;
    return {
      name: legacyCard!.full_name,
      expirationDate,
      active: expirationDate !== null && expirationDate >= today,
      // Nothing to revoke: a revocation is keyed on a `members` row, and
      // this branch is the case where there is none.
      revoked: false,
    };
  }

  const revoked = member.revoked_card !== null;
  return {
    name: cardNameText(member) || null,
    // Nothing to be good through once it is revoked.
    expirationDate: revoked ? null : member.expiration_date,
    active: isMembershipCurrent({ revoked: revoked ? 1 : 0, expiration_date: member.expiration_date }, today),
    revoked,
  };
}
