import { describe, expect, it } from "vitest";
import { AdminPage } from "../src/admin/layout";
import { Page } from "../src/member/layout";
import { LOS_VERDES_SITE_URL, SOURCE_REPOSITORY_URL } from "../src/siteFooter";

async function render(element: unknown): Promise<string> {
  return String(await (element as { toString(): string | Promise<string> }).toString());
}

describe("the footer on every page", () => {
  it.each([
    ["member", () => <Page title="A member page">content</Page>],
    ["admin", () => <AdminPage title="An admin page">content</AdminPage>],
  ])("links a %s page back to the card, the group's site, the privacy policy and the repository", async (_, page) => {
    const html = await render(page());

    expect(html).toContain('<a href="/">Your membership card</a>');
    expect(html).toContain(`<a href="${LOS_VERDES_SITE_URL}">Los Verdes</a>`);
    expect(html).toContain('<a href="/privacy-policy">Privacy</a>');
    expect(html).toContain(`<a href="${SOURCE_REPOSITORY_URL}">Help improve this site on GitHub</a>`);
  });
});
