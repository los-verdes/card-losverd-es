import "../setup/d1";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueUnsubscribeToken } from "../../src/email/unsubscribeToken";
import worker from "../../src/index";
import { fakeSuppressionList, type FakeSuppressionList } from "../fixtures/suppressionList";

const ORIGIN = "https://card.losverd.es";
const KEY = "test-session-signing-key-0123456789";
const ADDRESS = "jane@example.com";

let list: FakeSuppressionList;
let token: string;

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = KEY;
  env.CLOUDFLARE_ACCOUNT_ID = "0123456789abcdef";
  env.EMAIL_SUPPRESSIONS_API_TOKEN = "test-token";
  list = fakeSuppressionList();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    return (await list.handle(input, init)) ?? new Response("unexpected", { status: 599 });
  });
  token = await issueUnsubscribeToken(KEY, ADDRESS);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM audit_log");
});

async function request(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  const body = await res.text();
  await waitOnExecutionContext(ctx);
  return { status: res.status, body };
}

const page = (t = token) => request(`/email/unsubscribe?token=${encodeURIComponent(t)}`);
const stop = (body?: string) =>
  request(`/email/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body ?? "",
  });
const resume = () => request(`/email/unsubscribe/resume?token=${encodeURIComponent(token)}`, { method: "POST" });

async function auditLines() {
  const { results } = await env.DB.prepare(
    "SELECT action, subject_email, actor_email, detail FROM audit_log ORDER BY id",
  ).all();
  return results;
}

describe("the unsubscribe link", () => {
  it("asks first, and changes nothing by being opened", async () => {
    // Mail scanners open links to check them. If opening one unsubscribed,
    // people who never clicked would stop getting their cards.
    const { status, body } = await page();

    expect(status).toBe(200);
    expect(body).toContain("Stop card emails?");
    expect(body).toContain(ADDRESS);
    expect(body).toContain(`<form method="post" action="/email/unsubscribe?token=`);
    expect(list.rows).toEqual([]);
    expect(list.requests.every((r) => r.startsWith("GET"))).toBe(true);
  });

  it("stops card emails to the address when the button is pressed, and records who asked", async () => {
    const { status, body } = await stop();

    expect(status).toBe(200);
    expect(body).toContain("Card emails stopped");
    expect(list.rows.map((r) => r.email)).toEqual([ADDRESS]);
    expect(await auditLines()).toEqual([
      {
        action: "email.unsubscribed",
        subject_email: ADDRESS,
        actor_email: ADDRESS,
        detail: "From the unsubscribe link in a card email",
      },
    ]);
  });

  it("accepts a mail client's one-click unsubscribe, and says that is how it came", async () => {
    // RFC 8058: the client POSTs this body to the List-Unsubscribe URL, from
    // no page, with no cookie -- which is why there is no CSRF check here.
    const { status } = await stop("List-Unsubscribe=One-Click");

    expect(status).toBe(200);
    expect(list.rows).toHaveLength(1);
    expect((await auditLines())[0]).toMatchObject({ detail: "With their mail client's unsubscribe button" });
  });

  it("shows an address that has already stopped them, with a way back", async () => {
    await stop();

    const { body } = await page();

    expect(body).toContain("Card emails stopped");
    expect(body).toContain('action="/email/unsubscribe/resume?token=');
  });

  it("starts them again", async () => {
    await stop();

    const { status, body } = await resume();

    expect(status).toBe(200);
    expect(body).toContain("Card emails back on");
    expect(list.rows).toEqual([]);
    expect((await auditLines()).map((l) => l.action)).toEqual(["email.unsubscribed", "email.resubscribed"]);
  });

  it("offers no way back past a bounce or spam report, and says who can lift it", async () => {
    // Cloudflare's own rows are read-only, so a "start again" button would
    // do nothing and say it had.
    list.rows.push({ id: "cf", email: ADDRESS, reason: "complaint", read_only: true });

    const opened = await page();
    const resumed = await resume();

    for (const { body } of [opened, resumed]) {
      expect(body).toContain("reported as");
      expect(body).toContain("merchteam@losverdesatx.org");
      expect(body).not.toContain("/email/unsubscribe/resume");
    }
    expect(list.rows).toHaveLength(1);
  });

  it("turns away a link that isn't one, without touching the list", async () => {
    for (const bad of ["", "not-a-token", `${token}x`]) {
      const { status, body } = await page(bad);
      expect(status).toBe(400);
      expect(body).toContain("cut short when it was copied");
    }
    expect(list.requests).toEqual([]);
  });

  it("says it can't, rather than that it did, when the list can't be reached", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    list.failWith = "Authentication error";

    for (const { status, body } of [await page(), await stop(), await resume()]) {
      expect(status).toBe(503);
      expect(body).toContain("Nothing has changed");
    }
    expect(await auditLines()).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(3);
  });

  it("says the same when this environment has no token for the list", async () => {
    env.EMAIL_SUPPRESSIONS_API_TOKEN = undefined;

    for (const { status } of [await page(), await stop(), await resume()]) {
      expect(status).toBe(503);
    }
    expect(list.requests).toEqual([]);
  });
});
