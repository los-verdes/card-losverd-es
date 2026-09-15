import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('health check', () => {
  it('responds 200 on /healthz', async () => {
    const res = await SELF.fetch('https://example.com/healthz');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });
});
