import { Hono } from 'hono';

export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ status: 'ok' }));

export default app;
