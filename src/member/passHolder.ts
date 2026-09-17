import type { Env } from "../index";

export interface PassHolder {
  name: string | null;
  /** ISO8601 `YYYY-MM-DD`, or null if unknown. */
  expirationDate: string | null;
  active: boolean;
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
    "SELECT first_name, last_name, status, expiration_date FROM members WHERE email = ?",
  )
    .bind(email)
    .first<{
      first_name: string;
      last_name: string;
      status: string;
      expiration_date: string | null;
    }>();
  if (!member) {
    // A legacy card holder BigCommerce sync never created a row for (e.g. a
    // long-lapsed Squarespace-era member): all we know is that card's dates.
    const expirationDate = legacyCard!.member_until;
    return {
      name: legacyCard!.full_name,
      expirationDate,
      active: expirationDate !== null && expirationDate >= today,
    };
  }

  return {
    name: `${member.first_name} ${member.last_name}`.trim() || null,
    expirationDate: member.expiration_date,
    active:
      member.status !== "revoked" &&
      member.expiration_date !== null &&
      member.expiration_date >= today,
  };
}
