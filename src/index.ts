import { Hono } from 'hono';
import { cardRenderingSpike } from './spikes/card-rendering/route';

export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ status: 'ok' }));

// Phase 1.0.2 risk spike: Satori + @resvg/resvg-wasm card-image rendering.
// Not real member data -- see .ai/gcp-to-cf_plan.md Phase 1.0.2 and
// src/spikes/card-rendering/ for details.
app.route('/spikes/card-rendering', cardRenderingSpike);

export default app;
