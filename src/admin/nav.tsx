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
 * what makes them different.
 */

import { tryGetContext } from "hono/context-storage";
import type { FC } from "hono/jsx";
import { toIsoSeconds } from "../bigcommerce/orders";
import type { Env } from "../index";
import { attentionCounts, type AttentionCounts } from "./reportQueries";

interface NavLink {
  href: string;
  label: string;
  /** For a report that lists things wanting action: which count sizes it. */
  attention?: keyof AttentionCounts;
}

interface NavGroup {
  label: string;
  links: NavLink[];
}

export const ADMIN_NAV: NavGroup[] = [
  {
    label: "Reports",
    links: [
      { href: "/admin/reports", label: "All" },
      { href: "/admin/reports/active", label: "Active" },
      { href: "/admin/reports/expired", label: "Expired" },
      { href: "/admin/reports/orders", label: "By month" },
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
      { href: "/admin/revocations", label: "Revoked & expelled" },
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
 * admin's eye goes to the one that has something in it. It stays a link
 * either way -- an empty report is still worth being able to confirm.
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
 * `current` marks the page being read, which matters more here than on the
 * admin pages: the member's own card is in this nav, so without it an admin
 * looking at their card sees a link offering to take them where they already
 * are.
 */
export const AdminNav: FC<{ current?: string }> = async ({ current }) => {
  const counts = await currentAttentionCounts();
  return (
    <nav class="admin-nav">
      {ADMIN_NAV.map((group) => (
        <span class="nav-group">
          <span class="nav-label">{group.label}</span>
          {group.links.map((link) =>
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
