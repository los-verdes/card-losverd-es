/**
 * How many people held an active membership on each day, for the members-over-
 * time report (src/admin/reports.tsx).
 *
 * "Active on a day" is exactly what the Active memberships report means when
 * asked about that day (`activeMemberships()` as of the end of it): somebody
 * with a counted order placed by then that had not yet expired, revoked and
 * expelled people left out. Counted from the same rows, by the same rule, so
 * the two cannot disagree -- test/admin/membersOverTime.spec.ts holds them to
 * it day by day.
 *
 * Worked out in one pass rather than one query per day. Each order is active
 * from the day it was placed until the day before it expires (every stored
 * time is `YYYY-MM-DDTHH:MM:SSZ`, so "placed by the end of the day" and
 * "expires after the end of the day" come down to comparing dates). A
 * person's overlapping renewals are merged into continuous stretches, so
 * somebody who renewed early is one member, not two, and each stretch adds
 * one on its first day and takes it away on the day after its last.
 */

export interface CountedOrder {
  member_email: string;
  created_on: string;
  expires_on: string;
}

const DAY_MS = 86_400_000;

function dayNumber(isoDate: string): number {
  return Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10))) / DAY_MS;
}

export function isoDay(dayNumberValue: number): string {
  return new Date(dayNumberValue * DAY_MS).toISOString().slice(0, 10);
}

/** Active members on every day from `first` to `last` (`YYYY-MM-DD`, both included). */
export function activeMembersByDay(orders: CountedOrder[], first: string, last: string): { day: string; members: number }[] {
  const start = dayNumber(first);
  const length = dayNumber(last) - start + 1;
  if (length <= 0) return [];
  const change = new Int32Array(length + 1);

  const byMember = new Map<string, [number, number][]>();
  for (const order of orders) {
    const from = dayNumber(order.created_on);
    const until = dayNumber(order.expires_on); // the first day it no longer counts
    if (until <= from) continue;
    const periods = byMember.get(order.member_email);
    if (periods) periods.push([from, until]);
    else byMember.set(order.member_email, [[from, until]]);
  }

  const add = (from: number, until: number) => {
    const a = Math.max(from - start, 0);
    const b = Math.min(until - start, length);
    if (a >= b) return;
    change[a]++;
    change[b]--;
  };
  for (const periods of byMember.values()) {
    periods.sort((x, y) => x[0] - y[0]);
    let [from, until] = periods[0];
    for (const [nextFrom, nextUntil] of periods.slice(1)) {
      if (nextFrom <= until) {
        until = Math.max(until, nextUntil);
      } else {
        add(from, until);
        [from, until] = [nextFrom, nextUntil];
      }
    }
    add(from, until);
  }

  const series: { day: string; members: number }[] = [];
  let members = 0;
  for (let i = 0; i < length; i++) {
    members += change[i];
    series.push({ day: isoDay(start + i), members });
  }
  return series;
}
