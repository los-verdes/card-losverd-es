import { Hono } from "hono";
import bigcommerce from "./bigcommerce/routes";
import { handleEtlSyncBatch, type EtlSyncMessage } from "./queues/etlSync";
import { scheduled } from "./scheduled";

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
}

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ status: "ok" }));
app.route("/bigcommerce", bigcommerce);

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
  queue: handleEtlSyncBatch,
  scheduled,
};
