import "./setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../src/auth/session";
import { FORM_BUSY_SCRIPT } from "../src/formBusy";
import worker from "../src/index";

afterEach(async () => {
  await env.DB.exec("DELETE FROM users");
});

async function page(path: string, cookie?: string) {
  const res = await worker.fetch(
    new Request(`https://card.losverd.es${path}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" }),
    env,
    createExecutionContext(),
  );
  return res.text();
}

describe("the busy state on submitted forms", () => {
  it("is on member pages and admin pages alike", async () => {
    env.SESSION_SIGNING_KEY = "test-session-signing-key-0123456789";
    await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (1, 'admin@example.com', 1)").run();
    const token = await issueSessionToken(env.SESSION_SIGNING_KEY, { userId: 1, isAdmin: true });

    for (const html of [await page("/login"), await page("/admin/members", `${SESSION_COOKIE_NAME}=${token}`)]) {
      expect(html).toContain('document.addEventListener("submit"');
    }
  });

  it("never disables the pressed button, whose name and value the form may need", () => {
    // A disabled submitter is left out of the submission, and forms here tell
    // their buttons apart that way (`action=save` / `action=clear`). Checked
    // in Chrome when this was written; this keeps anyone from "simplifying"
    // it back to `disabled`.
    expect(FORM_BUSY_SCRIPT).not.toMatch(/\.disabled\s*=|setAttribute\("disabled"/);
    expect(FORM_BUSY_SCRIPT).toContain('setAttribute("aria-disabled", "true")');
  });
});
