// Every spec starts with an empty template image cache: specs put, change and
// delete R2's template images between cases, and the cache
// (src/member/artifacts.ts) would otherwise hand one case the bytes another
// left behind.
import { beforeEach } from "vitest";
import { resetTemplateAssetCache } from "../../src/member/artifacts";

beforeEach(() => {
  resetTemplateAssetCache();
});
