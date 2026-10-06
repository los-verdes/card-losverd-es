/**
 * The card on the store (#38): what the storefront script
 * (src/bigcommerce/storefront.ts) needs to draw a member's card on their
 * store account page and the membership page.
 *
 * - `GET /store/member` takes the store's `current.jwt` as a bearer token,
 *   from the store's own origin only (CORS), with no cookies, and answers
 *   JSON: whether that store account is connected, and if so the card it
 *   leads to. It only reads, so unlike the handoff a token may be used more
 *   than once in its lifetime. The customer is resolved through
 *   `users.bigcommerce_id` alone: never an order, never an email.
 * - The card image and both wallet passes are behind `lv_session` on the
 *   card site, which a store page doesn't carry. The JSON carries links to
 *   them instead, each signed for one member, one artifact and half an hour
 *   (`/store/card.png`, `/store/apple.pkpass`, `/store/google`). A drawn card
 *   is cached (#395), so the image is cheap to serve.
 *
 * Changing the name or theme, or emailing the card, happens on the card
 * site, through the store handoff (src/bigcommerce/storeHandoff.tsx).
 */

import { Hono, type Context } from "hono";
import type { Env } from "../index";
import { isUserExpelled } from "../member/expulsion";
import {
  buildGoogleWalletSaveUrl,
  cardNameText,
  getApplePassBundle,
  getMemberById,
  isGoogleWalletConfigured,
  isMembershipCurrent,
  renderCardImage,
  type MemberRecord,
} from "../member/artifacts";
import { findMembershipsForUser } from "../member/portal";
import { recordOutcome } from "../lib/outcome";
import { AppJwtRejected, appConfig, verifyCurrentCustomer } from "./appJwt";
import { userForStoreCustomer } from "./storeAccount";
import { hmac, storefrontOrigin } from "./storeHandoff";

export const STORE_MEMBER_PATH = "/store/member";
/** How long a signed link lasts: long enough for a panel left open a while, short enough not to be worth keeping. */
export const STORE_LINK_TTL_MS = 30 * 60 * 1000;

const ARTIFACTS = {
  card: "/store/card.png",
  apple: "/store/apple.pkpass",
  google: "/store/google",
} as const;
type Artifact = keyof typeof ARTIFACTS;

async function signature(env: Env, artifact: Artifact, memberId: string, expires: number): Promise<string> {
  return hmac(env.SESSION_SIGNING_KEY, `store-artifact:${artifact}:${memberId}:${expires}`);
}

/** A link to one of a member's artifacts, good for `STORE_LINK_TTL_MS`. */
export async function signedArtifactUrl(env: Env, artifact: Artifact, memberId: string, now = Date.now()): Promise<string> {
  const expires = now + STORE_LINK_TTL_MS;
  const url = new URL(ARTIFACTS[artifact], env.PUBLIC_BASE_URL);
  url.searchParams.set("m", memberId);
  url.searchParams.set("x", String(expires));
  url.searchParams.set("s", await signature(env, artifact, memberId, expires));
  return url.toString();
}

/** The member a signed link names, if it is genuine, in date, and they are still current. */
async function memberFromSignedLink(c: Context<{ Bindings: Env }>, artifact: Artifact): Promise<MemberRecord | null> {
  const { m: memberId, x, s } = c.req.query();
  const expires = Number(x);
  if (!memberId || !s || !Number.isFinite(expires) || expires < Date.now()) return null;
  const expected = await signature(c.env, artifact, memberId, expires);
  let difference = expected.length ^ s.length;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ (s.charCodeAt(i) || 0);
  if (difference !== 0) return null;
  const member = await getMemberById(c.env, memberId);
  return member && isMembershipCurrent(member) ? member : null;
}

/** What `/store/member` answers. */
export type StoreMemberResponse =
  | { connected: false }
  | { connected: true; member: null }
  | {
      connected: true;
      member: {
        name: string;
        cardNumber: string;
        /** `YYYY-MM-DD`, or null for no counted orders. */
        goodThrough: string | null;
        memberSince: string | null;
        current: boolean;
        /** Present only while the membership is current. */
        cardImageUrl?: string;
        appleWalletUrl?: string;
        googleWalletUrl?: string;
      };
    };

const store = new Hono<{ Bindings: Env }>();

/** CORS for the store's origin only, and nothing cached anywhere. */
function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
}

store.options(STORE_MEMBER_PATH, (c) => {
  const origin = storefrontOrigin(c.env);
  if (!appConfig(c.env) || !origin || c.req.header("Origin") !== origin) return c.body(null, 403);
  return c.body(null, 204, corsHeaders(origin));
});

store.get(STORE_MEMBER_PATH, async (c) => {
  const app = appConfig(c.env);
  const origin = storefrontOrigin(c.env);
  if (!app || !origin) return c.notFound();
  // A browser always sends Origin on a cross-origin fetch; anything that
  // names another site is refused outright rather than answered unreadably.
  const requestOrigin = c.req.header("Origin");
  if (requestOrigin !== undefined && requestOrigin !== origin) return c.json({ error: "origin" }, 403);
  const headers = corsHeaders(origin);

  const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "")?.[1] ?? "";
  let customerId: number;
  try {
    ({ customerId } = await verifyCurrentCustomer(token, app));
  } catch (err) {
    if (!(err instanceof AppJwtRejected)) throw err;
    recordOutcome("store.member", { result: "refused", reason: err.reason });
    return c.json({ error: "token" }, 401, headers);
  }

  const holder = await userForStoreCustomer(c.env, customerId);
  if (!holder) {
    recordOutcome("store.member", { result: "not_connected" });
    return c.json({ connected: false } satisfies StoreMemberResponse, 200, headers);
  }
  // Somebody expelled sees no card here, as they couldn't sign in to see one.
  if (await isUserExpelled(c.env, holder.id)) {
    recordOutcome("store.member", { result: "refused", reason: "expelled" });
    return c.json({ connected: true, member: null } satisfies StoreMemberResponse, 200, headers);
  }
  const memberships = (await findMembershipsForUser(c.env, holder.id)).filter((m): m is MemberRecord => m !== null);
  // Their current card if they have one, otherwise the one that ran out last.
  const member =
    memberships.find((m) => isMembershipCurrent(m)) ??
    memberships.sort((a, b) => (b.expiration_date ?? "").localeCompare(a.expiration_date ?? ""))[0] ??
    null;
  if (!member) {
    recordOutcome("store.member", { result: "no_membership" });
    return c.json({ connected: true, member: null } satisfies StoreMemberResponse, 200, headers);
  }

  const current = isMembershipCurrent(member);
  const body: StoreMemberResponse = {
    connected: true,
    member: {
      name: cardNameText(member),
      cardNumber: member.member_id,
      goodThrough: member.expiration_date,
      memberSince: member.member_since,
      current,
      ...(current
        ? {
            cardImageUrl: await signedArtifactUrl(c.env, "card", member.member_id),
            appleWalletUrl: await signedArtifactUrl(c.env, "apple", member.member_id),
            ...(isGoogleWalletConfigured(c.env) ? { googleWalletUrl: await signedArtifactUrl(c.env, "google", member.member_id) } : {}),
          }
        : {}),
    },
  };
  recordOutcome("store.member", { result: current ? "card" : "lapsed" });
  return c.json(body, 200, headers);
});

/** A signed link that has run out, or no longer names a current member: said plainly, since a person followed it. */
const expiredLink = (c: Context<{ Bindings: Env }>) =>
  c.text("This link from the store has run out. Reload the store page and try again.", 404, { "Cache-Control": "no-store" });

store.get(ARTIFACTS.card, async (c) => {
  const member = await memberFromSignedLink(c, "card");
  if (!member) return expiredLink(c);
  const png = await renderCardImage(c.env, member, undefined, (work) => c.executionCtx.waitUntil(work));
  return new Response(png as Uint8Array<ArrayBuffer>, {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" },
  });
});

store.get(ARTIFACTS.apple, async (c) => {
  const member = await memberFromSignedLink(c, "apple");
  if (!member) return expiredLink(c);
  const bundle = await getApplePassBundle(c.env, member);
  recordOutcome("pass.downloaded", { wallet: "apple", from: "store" });
  return new Response(bundle as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": "application/vnd.apple.pkpass",
      "Content-Disposition": 'attachment; filename="los-verdes-membership.pkpass"',
      "Cache-Control": "private, no-store",
    },
  });
});

store.get(ARTIFACTS.google, async (c) => {
  const member = await memberFromSignedLink(c, "google");
  if (!member) return expiredLink(c);
  try {
    const saveUrl = await buildGoogleWalletSaveUrl(c.env, member);
    recordOutcome("pass.downloaded", { wallet: "google", result: "ok", from: "store" });
    return c.redirect(saveUrl);
  } catch (err) {
    console.error("Google Wallet save link unavailable:", err);
    recordOutcome("pass.downloaded", { wallet: "google", result: "unavailable", from: "store" });
    return c.text("Google Wallet isn't available right now. Please try again later.", 503, { "Cache-Control": "no-store" });
  }
});

export default store;
