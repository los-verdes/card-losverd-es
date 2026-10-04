import "./setup/d1";
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('health check', () => {
  it('responds 200 on /healthz', async () => {
    const res = await SELF.fetch('https://example.com/healthz');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });
});

describe("store.losverd.es", () => {
  const fetchAt = (url: string) => SELF.fetch(url, { redirect: "manual" });

  it("sends everything to the store, path and query kept", async () => {
    const res = await fetchAt("https://store.losverd.es/membership/?ref=flyer");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${new URL("/", env.BIGCOMMERCE_STOREFRONT_URL).origin}/membership/?ref=flyer`);
    expect((await fetchAt("https://store.losverd.es/")).headers.get("Location")).toBe(new URL("/", env.BIGCOMMERCE_STOREFRONT_URL).toString());
  });

  it("leaves the card site's own address alone", async () => {
    expect((await fetchAt("https://card.losverd.es/healthz")).status).toBe(200);
  });
});
