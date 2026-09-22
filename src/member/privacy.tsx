/**
 * The privacy policy, at the URL Google's OAuth consent screen links to.
 *
 * Deliberately short, and deliberately a promise to use members' data for
 * running their card and nothing else. When this and some other use of the
 * data disagree, this wins. Change it when what the site keeps changes --
 * the tables in src/db/migrations/ and the README's "What we record about
 * visits" are what it summarises.
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { Page, SUPPORT_EMAIL } from "./layout";

export const PRIVACY_PATH = "/privacy-policy";

const privacy = new Hono<{ Bindings: Env }>();

privacy.get("/", (c) =>
  c.html(
    <Page title="Privacy">
      <h1>Privacy</h1>
      <p>
        This site shows Los Verdes members their membership card. We keep only what that needs, use it only for
        that, and never sell it or share it. Where anything here is unclear, your privacy comes first.
      </p>
      <h2>What we keep</h2>
      <ul style="text-align: left">
        <li>From your membership orders: your name, email address and order dates.</li>
        <li>When you sign in with Google or Apple: your email address and the account ID they give us.</li>
        <li>A name you choose to show on your card, if you set one.</li>
        <li>If you add your card to Apple Wallet: an ID for your device, so your card can be updated.</li>
      </ul>
      <p>
        We compare members' email addresses with the Los Verdes Slack workspace, so the group can see which members
        have joined it. Only the volunteers who run memberships can see any of this, and it is stored with Cloudflare,
        which hosts the site. The one exception is your card's QR code: scanning it shows the name on the card and
        whether that membership is current.
      </p>
      <h2>What we don't do</h2>
      <p>
        No advertising and no tracking. Cookies are used only to sign you in and keep you signed in, for up to 30
        days. Visit statistics are anonymous and use no cookies.
      </p>
      <h2>Questions, or want your data removed?</h2>
      <p>
        Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </Page>,
  ),
);

export default privacy;
