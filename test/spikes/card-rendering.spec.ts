import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// PNG file signature: 0x89 'P' 'N' 'G' \r \n 0x1A \n
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('card-rendering spike', () => {
  it('renders a non-trivial PNG for the default sample card', async () => {
    const res = await SELF.fetch('https://example.com/spikes/card-rendering');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');

    const bytes = new Uint8Array(await res.arrayBuffer());

    // Real PNG, not an empty/error response.
    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_MAGIC);
    // A ~1050x660 rendered card should be comfortably more than a few KB;
    // this guards against a "successful" render that's actually a blank or
    // near-blank image (e.g. Satori's remote-image-fetch-fails-silently
    // failure mode the migration plan warns about).
    expect(bytes.byteLength).toBeGreaterThan(5_000);
  });

  it('honors query-string overrides for member data', async () => {
    const res = await SELF.fetch(
      'https://example.com/spikes/card-rendering?name=Test+Member&tier=Family&serial=LV-99999&expires=Good+through+Jan+1%2C+2027',
    );
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_MAGIC);
    expect(bytes.byteLength).toBeGreaterThan(5_000);
  });
});
