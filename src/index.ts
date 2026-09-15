import { Hono } from 'hono';
import { pkcs7SigningSpike } from './spikes/pkcs7-signing/route';

export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ status: 'ok' }));

// Phase 1.0.1 risk spike -- see src/spikes/pkcs7-signing/route.ts and
// test/spikes/pkcs7-signing.spec.ts. Throwaway/spike code, not part of the
// real pass-serving surface (that's Phase 4).
app.route('/spikes/pkcs7-signing', pkcs7SigningSpike);

export default app;
