import "../setup/d1";
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { legacyCardUuid } from "../../src/passkit/legacyPasses";

const PASS_TYPE_ID = "pass.es.losverd.card";
const BASE = "https://example.com/passkit";
const DEVICE = "0123456789abcdef0123456789abcdef";
/** A synthetic legacy card: the UUID the QR codes use, and the integer its pass carries. */
const LEGACY_UUID = "0cd5ad74-5fbc-40fd-9569-747fec277013";
const LEGACY_SERIAL = BigInt("0x0cd5ad745fbc40fd9569747fec277013").toString();

function registrationUrl(serial: string) {
  return `${BASE}/v1/devices/${DEVICE}/registrations/${PASS_TYPE_ID}/${serial}`;
}

// What a legacy pass sends: its own token, which this site cannot check.
const LEGACY_AUTH = { Authorization: "ApplePass legacy-token-this-site-never-had=" };

beforeEach(async () => {
  await env.DB.prepare(
    "INSERT INTO legacy_membership_cards (serial_number, email, full_name, member_since, member_until) VALUES (?, 'old@example.com', 'Old Member', '2019-01-01', '2020-01-01')",
  )
    .bind(LEGACY_UUID)
    .run();
});

afterEach(async () => {
  await env.DB.exec("DELETE FROM registrations");
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM legacy_membership_cards");
});

describe("legacyCardUuid", () => {
  it("turns a legacy pass serial back into the card UUID the QR codes use", () => {
    expect(legacyCardUuid(LEGACY_SERIAL)).toBe(LEGACY_UUID);
  });

  it.each(["LV-6f1c8e40-0000-4000-8000-a1b2c3d4e5f6", "12ab", "", String(1n << 128n)])("rejects %s", (serial) => {
    expect(legacyCardUuid(serial)).toBeNull();
  });
});

describe("a pass from the previous site", () => {
  it("is acknowledged when it registers, so the phone stops retrying, and nothing is stored", async () => {
    const res = await SELF.fetch(registrationUrl(LEGACY_SERIAL), {
      method: "POST",
      headers: { ...LEGACY_AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ pushToken: "legacy-push-token" }),
    });

    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM registrations").first()).toEqual({ n: 0 });
  });

  it("is acknowledged when it unregisters", async () => {
    const res = await SELF.fetch(registrationUrl(LEGACY_SERIAL), { method: "DELETE", headers: LEGACY_AUTH });

    expect(res.status).toBe(200);
  });

  it("has no newer copy to fetch", async () => {
    const res = await SELF.fetch(`${BASE}/v1/passes/${PASS_TYPE_ID}/${LEGACY_SERIAL}`, { headers: LEGACY_AUTH });

    expect(res.status).toBe(304);
  });

  it("is still refused for an integer serial that is no card we know", async () => {
    const unknown = BigInt("0x11111111222233334444555555555555").toString();

    const res = await SELF.fetch(registrationUrl(unknown), {
      method: "POST",
      headers: { ...LEGACY_AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ pushToken: "x" }),
    });

    expect(res.status).toBe(401);
  });
});
