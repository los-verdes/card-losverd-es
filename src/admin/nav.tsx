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

import type { FC } from "hono/jsx";

interface NavLink {
  href: string;
  label: string;
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
      { href: "/admin/reports/missing", label: "Missing orders" },
      { href: "/admin/reports/extra-memberships", label: "Extra memberships" },
    ],
  },
  {
    label: "Members",
    links: [
      { href: "/admin/members", label: "Find" },
      { href: "/admin/member-since", label: "Member since" },
      { href: "/admin/revocations", label: "Revoked & expelled" },
      { href: "/admin/audit", label: "History" },
    ],
  },
  {
    label: "This environment",
    links: [
      { href: "/admin/preflight", label: "Readiness" },
      { href: "/", label: "My card" },
    ],
  },
];

/**
 * `current` marks the page being read, which matters more here than on the
 * admin pages: the member's own card is in this nav, so without it an admin
 * looking at their card sees a link offering to take them where they already
 * are.
 */
export const AdminNav: FC<{ current?: string }> = ({ current }) => (
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
            <a href={link.href}>{link.label}</a>
          ),
        )}
      </span>
    ))}
  </nav>
);
