/**
 * The callbacks BigCommerce makes to this environment's Developer Portal app
 * (#38). The app exists so storefront JavaScript can ask the store who is
 * signed in (`current.jwt`, signed with the app's client secret); it is
 * installed from the store's Marketplace, under My Drafts.
 *
 * - **Auth** (`/bigcommerce/app/auth`), at install: exchanges the one-time
 *   code at `login.bigcommerce.com`, which completes the install, and refuses
 *   any store but this environment's. It keeps nothing: nothing here calls
 *   the store's API as the app, so the access token it receives is not stored.
 * - **Load** (`/bigcommerce/app/load`), when an admin opens the app in the
 *   control panel: verifies the store's `signed_payload_jwt` and says what
 *   the app is for.
 * - **Uninstall** (`/bigcommerce/app/uninstall`): verifies the payload and
 *   logs it. The handoff stops working until the app is installed again.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import type { Env } from "../index";
import { AppJwtRejected, appConfig, verifySignedPayload } from "./appJwt";

export const BIGCOMMERCE_TOKEN_URL = "https://login.bigcommerce.com/oauth2/token";

const app = new Hono<{ Bindings: Env }>();

const ControlPanelPage: FC<{ title: string; children?: unknown }> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>{title}</title>
      <style>{"body{font-family:system-ui,sans-serif;margin:2rem;max-width:40rem;line-height:1.5}"}</style>
    </head>
    <body>
      <h1 style="font-size:1.4rem">{title}</h1>
      {children}
    </body>
  </html>
);

/** The store hash out of an install's `context` (`stores/<hash>`). */
function storeHashOf(context: string | undefined): string | null {
  const match = /^stores\/([a-z0-9]+)$/.exec(context ?? "");
  return match ? match[1] : null;
}

app.get("/auth", async (c) => {
  const config = appConfig(c.env);
  if (!config) return c.text("This environment has no app configured.", 404);
  const { code, scope, context } = c.req.query();
  if (!code || storeHashOf(context) !== config.storeHash) {
    console.warn("bigcommerce app auth: refused", { reason: code ? "store" : "code" });
    return c.text("This app belongs to another store.", 403);
  }
  const res = await fetch(BIGCOMMERCE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      scope,
      context,
      grant_type: "authorization_code",
      redirect_uri: new URL("/bigcommerce/app/auth", c.env.PUBLIC_BASE_URL).toString(),
    }),
  });
  if (!res.ok) {
    console.warn("bigcommerce app auth: token exchange failed", { status: res.status });
    return c.text("The install could not be completed. Try installing again.", 502);
  }
  // The response carries an access token for the app's scopes. Nothing here
  // uses it, so it is dropped rather than stored.
  await res.body?.cancel();
  console.log("bigcommerce app auth: installed", { scope: scope ?? "" });
  return c.html(
    <ControlPanelPage title="Los Verdes membership card: installed">
      <p>The store can now send signed-in customers to their membership card. There is nothing to configure here.</p>
    </ControlPanelPage>,
  );
});

app.get("/load", async (c) => {
  const config = appConfig(c.env);
  if (!config) return c.text("This environment has no app configured.", 404);
  try {
    await verifySignedPayload(c.req.query("signed_payload_jwt") ?? "", config);
  } catch (err) {
    if (!(err instanceof AppJwtRejected)) throw err;
    console.warn("bigcommerce app load: refused", { reason: err.reason });
    return c.text("Forbidden", 403);
  }
  return c.html(
    <ControlPanelPage title="Los Verdes membership card">
      <p>
        This app lets customers signed in to the store open their Los Verdes membership card without signing in
        again. There is nothing to configure here.
      </p>
      <p>
        Membership records are managed at <a href={c.env.PUBLIC_BASE_URL}>{c.env.PUBLIC_BASE_URL}</a>.
      </p>
    </ControlPanelPage>,
  );
});

app.get("/uninstall", async (c) => {
  const config = appConfig(c.env);
  if (!config) return c.text("This environment has no app configured.", 404);
  try {
    await verifySignedPayload(c.req.query("signed_payload_jwt") ?? "", config);
  } catch (err) {
    if (!(err instanceof AppJwtRejected)) throw err;
    console.warn("bigcommerce app uninstall: refused", { reason: err.reason });
    return c.text("Forbidden", 403);
  }
  console.warn("bigcommerce app uninstall: the app was removed from the store; the store handoff stops working until it is reinstalled");
  return c.text("OK");
});

export default app;
