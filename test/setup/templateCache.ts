// Every spec starts with no cached template images and no cached drawn
// cards. Specs put, change and delete R2's template images and members
// between cases, and both caches (src/member/artifacts.ts) would otherwise
// hand one case what another left behind -- a card drawn for a member of the
// same card number and version in an earlier case, say.
import { env } from "cloudflare:test";
import { beforeEach } from "vitest";
import { resetTemplateAssetCache } from "../../src/member/artifacts";

export async function forgetDrawnCards(): Promise<void> {
  const { objects } = await env.ASSETS.list({ prefix: "cache/card/" });
  if (objects.length > 0) await env.ASSETS.delete(objects.map((object) => object.key));
}

beforeEach(async () => {
  resetTemplateAssetCache();
  await forgetDrawnCards();
});
