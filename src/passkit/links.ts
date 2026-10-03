import { LOS_VERDES_SITE_URL } from "../siteFooter";

/** A link both wallets show with the pass's details. */
export interface PassLink {
  id: string;
  label: string;
  url: string;
}

/**
 * The way back from a pass to this site and to the group's, in the order and
 * words the site's own footer uses. Apple shows them on the back of the pass,
 * Google in its list of links under the details.
 */
export function passLinks(siteUrl: string): PassLink[] {
  return [
    { id: "card_site", label: "Your membership card", url: new URL("/", siteUrl).toString() },
    { id: "los_verdes", label: "Los Verdes", url: new URL(LOS_VERDES_SITE_URL).toString() },
  ];
}

/** A link as the text it reads as: its host and path, without the scheme or a bare trailing slash. */
export function linkText(url: string): string {
  const { host, pathname } = new URL(url);
  return pathname === "/" ? host : `${host}${pathname}`;
}
