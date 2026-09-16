import type { Env as AppEnv } from "./index";

// Merges our Worker's `Env` (declared in src/index.ts) into the ambient
// `Cloudflare.Env` interface that `@cloudflare/workers-types` declares as
// an empty interface for exactly this purpose. This is what lets
// `import { env } from "cloudflare:test"` (used throughout test/) be typed
// as our real bindings instead of `{}`.
declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends AppEnv {}
  }
}

export {};
