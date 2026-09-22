import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { SUPPORT_EMAIL } from "../../src/member/layout";

async function get(path: string) {
  return worker.fetch(
    new Request(`https://card.losverd.es${path}`, { redirect: "manual" }),
    env,
    createExecutionContext(),
  );
}

describe("the privacy policy", () => {
  it("is public, at the URL Google's consent screen links to", async () => {
    // Nobody is signed in here: the page has to be readable before anyone
    // decides whether to sign in at all.
    const res = await get("/privacy-policy");

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Privacy</h1>");
    expect(body).toContain("never sell it or share it");
    expect(body).toContain(`mailto:${SUPPORT_EMAIL}`);
    // Reached from Google's consent screen, so it can be somebody's first
    // page here: it has to offer a way into the rest of the site.
    expect(body).toContain('<a href="/">Your membership card</a>');
  });

  it("is linked from the sign-in page", async () => {
    expect(await (await get("/login")).text()).toContain('<a href="/privacy-policy">Privacy</a>');
  });
});
