// Every spec starts with the real bundled template images, none of them
// cached, and no cached drawn cards. Specs swap template images
// (test/fixtures/templates.ts) and change members between cases, and both
// caches (src/member/artifacts.ts) would otherwise hand one case what another
// left behind -- a card drawn for a member of the same card number and
// version in an earlier case, say.
import { env } from "cloudflare:test";
import { beforeEach } from "vitest";
import { resetTemplateAssetCache } from "../../src/member/artifacts";
import { bundledTemplates } from "../fixtures/templates";

export async function forgetDrawnCards(): Promise<void> {
  const { objects } = await env.ASSETS.list({ prefix: "cache/card/" });
  if (objects.length > 0) await env.ASSETS.delete(objects.map((object) => object.key));
}

beforeEach(async () => {
  env.STATIC = bundledTemplates;
  resetTemplateAssetCache();
  await forgetDrawnCards();
});
