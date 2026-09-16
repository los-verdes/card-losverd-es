import { Hono } from 'hono';
import bigcommerce from "./bigcommerce/routes";
import passkit from "./passkit/routes";
import { handleEtlSyncBatch, type EtlSyncMessage } from "./queues/etlSync";
import { scheduled } from "./scheduled";
import { pkcs7SigningSpike } from './spikes/pkcs7-signing/route';

export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
  BIGCOMMERCE_STORE_HASH: string;
  BIGCOMMERCE_CLIENT_ID: string;
  BIGCOMMERCE_ACCESS_TOKEN: string;
  BIGCOMMERCE_WEBHOOK_SIGNING_KEY: string;
  // TODO(Phase 2.5.2): not yet declared in wrangler.toml - see
  // docs/bigcommerce-ingestion.md section 3/5. `enqueueEtlSync()` no-ops
  // when this binding is absent, so the rest of the ingestion path works
  // without it today.
  ETL_SYNC_QUEUE?: Queue<EtlSyncMessage>;
  // Not secret -- public pass/branding identifiers, see Phase 4.
  PASSKIT_PASS_TYPE_IDENTIFIER: string;
  PASSKIT_TEAM_IDENTIFIER: string;
  PASSKIT_ORGANIZATION_NAME: string;
  PASSKIT_WEB_SERVICE_URL: string;
  // Secret -- real Apple-issued cert/key/WWDR chain, per Phase 0.2/4.6.
  APPLE_PASS_CERT_PEM: string;
  APPLE_PASS_KEY_PEM: string;
  APPLE_WWDR_CERT_PEM: string;
  // Secret -- HS256 key for the `lv_session` cookie (Phase 2.3.1). Freshly
  // generated, NOT the legacy app's SECRET_KEY. Deliberately not given a
  // placeholder in wrangler.toml `[vars]`: set via `wrangler secret put`
  // (or `.dev.vars` locally). An unset key fails closed -- session
  // middleware throws rather than signing with an empty key.
  SESSION_SIGNING_KEY: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ status: "ok" }));
app.route("/bigcommerce", bigcommerce);

// Apple PassKit Web Service API (Phase 4). Mounted at `/passkit` to match
// the real `webServiceURL` value discovered in the legacy app's own passes
// ("https://card.losverd.es/passkit") -- Apple appends `/v1/...` to
// whatever `webServiceURL` a pass declares.
app.route("/passkit", passkit);

// Phase 1.0.1 risk spike -- see src/spikes/pkcs7-signing/route.ts and
// test/spikes/pkcs7-signing.spec.ts. Throwaway/spike code, not part of the
// real pass-serving surface (that's Phase 4).
app.route('/spikes/pkcs7-signing', pkcs7SigningSpike);

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
  queue: handleEtlSyncBatch,
  scheduled,
};
