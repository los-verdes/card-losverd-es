/**
 * The admin navigation, on its own so it is not only on admin pages.
 *
 * It started inside `AdminPage`, which meant an admin arriving at their own
 * card had one small link at the bottom of the page and no other way in. The
 * nav is the thing that says what an admin can do here, so it belongs
 * wherever an admin is, not only where they have already arrived.
 *
 * Grouped rather than listed: eleven links in one row read as a wall, and
 * each group carries the shared word so the links inside it only have to say
 * what makes them different. A group whose word names a page of its own --
 * "Reports", over the index of every report -- links it from the label, so
 * the page does not also take a place among the links it lists.
 */

import { tryGetContext } from "hono/context-storage";
import type { FC } from "hono/jsx";
import { toIsoSeconds } from "../bigcommerce/orders";
import { ProductionLabel } from "../environment";
import type { Env } from "../index";
import { attentionCounts, type AttentionCounts } from "./reportQueries";

interface NavLink {
  href: string;
  label: string;
  /** For a report that lists things wanting action: which count sizes it. */
  attention?: keyof AttentionCounts;
  /**
   * For a page that is empty nearly always: left out of the nav while this
   * count is zero, like an empty "Needs a look" group. Still shown when the
   * counts are unknown.
   */
  onlyWhenAny?: keyof AttentionCounts;
}

export interface NavGroup {
  label: string;
  /** The page the label itself links to, when the group has one. */
  href?: string;
  links: NavLink[];
}

export const ADMIN_NAV: NavGroup[] = [
  {
    label: "Reports",
    href: "/admin/reports",
    links: [
      { href: "/admin/reports/memberships", label: "Active & expired" },
      { href: "/admin/reports/over-time", label: "Over time" },
      { href: "/admin/reports/renewals", label: "Renewals" },
      { href: "/admin/reports/slack", label: "Slack" },
      { href: "/admin/reports/consolidations", label: "Consolidations" },
    ],
  },
  {
    label: "Needs a look",
    links: [
      { href: "/admin/reports/missing", label: "Missing orders", attention: "missing" },
      {
        href: "/admin/reports/extra-memberships",
        label: "Extra memberships",
        attention: "extraMemberships",
      },
    ],
  },
  {
    label: "Members",
    links: [
      { href: "/admin/members", label: "Find" },
      { href: "/admin/member-since", label: "Member since" },
      // Rare, and done from a member's own page; the list is only worth a
      // place in the nav once there is something on it.
      { href: "/admin/revocations", label: "Revoked & expelled", onlyWhenAny: "revocations" },
      { href: "/admin/audit", label: "Audit log" },
    ],
  },
  {
    label: "This environment",
    links: [
      { href: "/admin/preflight", label: "Readiness" },
      { href: "/admin/admins", label: "Admins" },
      { href: "/", label: "My card" },
    ],
  },
];

/**
 * The counts behind the "needs a look" links, or null when they can't be had.
 *
 * Read through the request's own context (`contextStorage` in src/index.ts)
 * rather than threaded through every page that renders the nav, which is
 * all of them. Null -- no request, or a failed query -- renders the links
 * plainly, as they were before counts existed: the nav must never be the
 * reason a page fails to load.
 */
async function currentAttentionCounts(): Promise<AttentionCounts | null> {
  const db = tryGetContext<{ Bindings: Env }>()?.env.DB;
  if (!db) return null;
  try {
    return await attentionCounts(db, toIsoSeconds(new Date()));
  } catch (error) {
    console.warn("Admin nav: could not count rows needing a look", error);
    return null;
  }
}

/**
 * A link to a report of things wanting action says whether there are any.
 *
 * With rows, a badge carries the count; with none, the link is muted, so an
 * admin's eye goes to the one that has something in it. When every report in
 * a group is empty the whole group is left out (`isQuietGroup`), so these
 * appear only when there is something to look at.
 */
const NavItem: FC<{ link: NavLink; counts: AttentionCounts | null }> = ({ link, counts }) => {
  const count = link.attention && counts ? counts[link.attention] : null;
  if (count === null) return <a href={link.href}>{link.label}</a>;
  if (count === 0) {
    return (
      <a href={link.href} class="nav-quiet" title="Nothing to look at">
        {link.label}
      </a>
    );
  }
  return (
    <a href={link.href}>
      {link.label}{" "}
      <span class="nav-count" aria-label={`${count} to look at`}>
        {count}
      </span>
    </a>
  );
};

/**
 * A link marked `onlyWhenAny` whose count is zero: left out, on every page
 * including its own, as an empty "Needs a look" group is. Shown whenever the
 * counts are unknown.
 */
export function isHiddenLink(link: NavLink, counts: AttentionCounts | null): boolean {
  return link.onlyWhenAny !== undefined && counts !== null && counts[link.onlyWhenAny] === 0;
}

/**
 * A group made only of reports of things wanting action, every one of them
 * empty. Left out of the nav: an empty "Needs a look" group, and the
 * explanations on its pages, confuse more admins than they reassure, so it
 * appears only when there is something to look at.
 *
 * Shown whenever the counts are unknown, since a failed count is not the same
 * as nothing to look at.
 */
export function isQuietGroup(group: NavGroup, counts: AttentionCounts | null): boolean {
  if (counts === null) return false;
  return group.links.every((link) => link.attention !== undefined && counts[link.attention] === 0);
}

/** A group's label: a link when the group has a page of its own and it is not this one. */
const NavLabel: FC<{ group: NavGroup; current?: string }> = ({ group, current }) => {
  if (!group.href) return <span class="nav-label">{group.label}</span>;
  if (group.href === current) {
    return (
      <span class="nav-label" aria-current="page">
        {group.label}
      </span>
    );
  }
  return (
    <a href={group.href} class="nav-label">
      {group.label}
    </a>
  );
};

/**
 * `current` marks the page being read, which matters more here than on the
 * admin pages: the member's own card is in this nav, so without it an admin
 * looking at their card sees a link offering to take them where they already
 * are.
 */
export const AdminNav: FC<{ current?: string }> = async ({ current }) => {
  const counts = await currentAttentionCounts();
  return (
    <nav class="admin-nav">
      <ProductionLabel />
      {ADMIN_NAV.filter((group) => !isQuietGroup(group, counts)).map((group) => (
        <span class="nav-group">
          <NavLabel group={group} current={current} />
          {group.links.filter((link) => !isHiddenLink(link, counts)).map((link) =>
            link.href === current ? (
              <span class="nav-here" aria-current="page">
                {link.label}
              </span>
            ) : (
              <NavItem link={link} counts={counts} />
            ),
          )}
        </span>
      ))}
    </nav>
  );
};
