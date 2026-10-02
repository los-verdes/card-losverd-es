/**
 * Links from the admin pages to the same order or customer in BigCommerce's
 * control panel. They open in a new tab, marked "↗", so it reads as leaving
 * the card site.
 *
 * The BigCommerce control panel is per store (`store-<hash>.mybigcommerce.com`),
 * so its links follow the environment's `BIGCOMMERCE_STORE_HASH`: staging's
 * point at the sandbox store. The hash is read through the request's own
 * context (`contextStorage` in src/index.ts), like the members' names, so no
 * page has to pass it around. Outside a request, or without a usable hash,
 * there is no link; the id still shows.
 *
 * Nothing links to MiniBC: its dashboard is reached through BigCommerce's
 * app sign-in, so a direct link to a subscription or customer there does not
 * open it.
 */

import { tryGetContext } from "hono/context-storage";
import type { FC, PropsWithChildren } from "hono/jsx";
import type { Env } from "../index";

/** The store's control panel, `https://store-<hash>.mybigcommerce.com/manage`, or null. */
export function bigCommerceManageBase(): string | null {
  const hash = tryGetContext<{ Bindings: Env }>()?.env?.BIGCOMMERCE_STORE_HASH;
  return hash && /^[a-z0-9]+$/.test(hash) ? `https://store-${hash}.mybigcommerce.com/manage` : null;
}

const positive = (id: number | string | null | undefined) => {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export const ExternalLink: FC<PropsWithChildren<{ href: string; title: string }>> = ({ href, title, children }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" title={title}>
    {children} ↗
  </a>
);

/** An order in BigCommerce. Only BigCommerce's own orders have one there. */
export const StoreOrderLink: FC<PropsWithChildren<{ orderId: string; source?: string }>> = ({ orderId, source = "bigcommerce", children }) => {
  const base = bigCommerceManageBase();
  const id = positive(orderId);
  if (!base || id === null || source !== "bigcommerce") return null;
  return (
    <ExternalLink href={`${base}/orders/${id}`} title="This order in BigCommerce">
      {children ?? "BigCommerce"}
    </ExternalLink>
  );
};

/** A customer in BigCommerce; a guest checkout's customer 0 has no page. */
export const StoreCustomerLink: FC<PropsWithChildren<{ customerId: number | string | null }>> = ({ customerId, children }) => {
  const base = bigCommerceManageBase();
  const id = positive(customerId);
  if (!base || id === null) return <>{children}</>;
  return (
    <ExternalLink href={`${base}/customers/${id}/edit`} title="This customer in BigCommerce">
      {children ?? `Customer ${id}`}
    </ExternalLink>
  );
};
