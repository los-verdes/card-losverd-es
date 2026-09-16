import { Hono } from "hono";
import type { Env } from "../index";
import { verifyPassAuthorization } from "../middleware/auth";
import {
  assemblePassBundle,
  getCachedPass,
  putCachedPass,
  type MemberPassInput,
  type PassKitConfig,
} from "./generator";
import type { PassSigningCredentials } from "./signer";

interface MemberRow {
  member_id: string;
  first_name: string;
  last_name: string;
  membership_tier: string;
  status: "active" | "expired" | "revoked";
  expiration_date: string | null;
  member_since: string | null;
  auth_token: string;
  last_updated_at: number;
}

/**
 * A `member_since_overrides` row (legacy import or set by hand) wins over
 * the order-derived `members.member_since`; see migration 0005.
 */
async function getMember(
  env: Env,
  memberId: string,
): Promise<MemberRow | null> {
  return env.DB.prepare(
    `SELECT m.member_id, m.first_name, m.last_name, m.membership_tier, m.status,
            m.expiration_date, COALESCE(o.member_since, m.member_since) AS member_since,
            m.auth_token, m.last_updated_at
     FROM members m LEFT JOIN member_since_overrides o ON o.email = m.email
     WHERE m.member_id = ?`,
  )
    .bind(memberId)
    .first<MemberRow>();
}

function toMemberPassInput(row: MemberRow): MemberPassInput {
  return {
    memberId: row.member_id,
    firstName: row.first_name,
    lastName: row.last_name,
    membershipTier: row.membership_tier,
    status: row.status,
    expirationDate: row.expiration_date,
    memberSince: row.member_since,
    authToken: row.auth_token,
  };
}

function passKitConfig(env: Env): PassKitConfig {
  return {
    passTypeIdentifier: env.PASSKIT_PASS_TYPE_IDENTIFIER,
    teamIdentifier: env.PASSKIT_TEAM_IDENTIFIER,
    organizationName: env.PASSKIT_ORGANIZATION_NAME,
    webServiceURL: env.PASSKIT_WEB_SERVICE_URL,
  };
}

function signingCredentials(env: Env): PassSigningCredentials {
  return {
    signingCertPem: env.APPLE_PASS_CERT_PEM,
    signingKeyPem: env.APPLE_PASS_KEY_PEM,
    wwdrCertPem: env.APPLE_WWDR_CERT_PEM,
  };
}

// Matches Phase 3.1's R2 `templates/apple/` layout -- no strip.png or
// thumbnail.png, confirmed against a real production pass while building
// the Phase 4 content generator (see generator.ts / PR #10): it's a
// `generic`-style pass, which doesn't render a strip image.
const TEMPLATE_ASSET_FILES = [
  "icon.png",
  "icon@2x.png",
  "logo.png",
  "logo@2x.png",
];

async function loadTemplateAssets(
  bucket: R2Bucket,
): Promise<Record<string, Uint8Array>> {
  const assets: Record<string, Uint8Array> = {};
  for (const name of TEMPLATE_ASSET_FILES) {
    const object = await bucket.get(`templates/apple/${name}`);
    if (!object) {
      throw new Error(
        `Missing pass template asset in R2: templates/apple/${name} (see Phase 3.2's asset migration script)`,
      );
    }
    assets[name] = new Uint8Array(await object.arrayBuffer());
  }
  return assets;
}

const passkit = new Hono<{ Bindings: Env }>();

/**
 * 4.1 Device Registration. Upserts the device's push token, then reports
 * whether this device/pass pairing already existed (200) or is new (201) --
 * Apple's spec requires this distinction, not just success/failure.
 */
passkit.post(
  "/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber",
  async (c) => {
    const { deviceLibraryIdentifier, passTypeIdentifier, serialNumber } =
      c.req.param();

    const member = await getMember(c.env, serialNumber);
    if (
      !member ||
      !verifyPassAuthorization(c.req.header("authorization"), member.auth_token)
    ) {
      return c.text("Unauthorized", 401);
    }

    let body: { pushToken?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.text("Bad Request: invalid JSON body", 400);
    }
    if (!body.pushToken) {
      return c.text("Bad Request: missing pushToken", 400);
    }

    await c.env.DB.prepare(
      `INSERT INTO devices (device_library_identifier, push_token) VALUES (?, ?)
       ON CONFLICT(device_library_identifier) DO UPDATE SET
         push_token = excluded.push_token,
         updated_at = (unixepoch('subsec') * 1000)`,
    )
      .bind(deviceLibraryIdentifier, body.pushToken)
      .run();

    const existing = await c.env.DB.prepare(
      "SELECT 1 FROM registrations WHERE device_library_identifier = ? AND serial_number = ?",
    )
      .bind(deviceLibraryIdentifier, serialNumber)
      .first();
    if (existing) {
      return c.text("OK", 200);
    }

    await c.env.DB.prepare(
      "INSERT INTO registrations (device_library_identifier, pass_type_identifier, serial_number) VALUES (?, ?, ?)",
    )
      .bind(deviceLibraryIdentifier, passTypeIdentifier, serialNumber)
      .run();

    return c.text("Created", 201);
  },
);

/**
 * 4.2 Up-to-Date Pass Query -- the polling-storm endpoint. No per-serial
 * auth check here (matches Apple's real spec): a device can only enumerate
 * registrations it itself created via 4.1, scoped by
 * `deviceLibraryIdentifier`, which only that device knows.
 */
passkit.get(
  "/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier",
  async (c) => {
    const { deviceLibraryIdentifier, passTypeIdentifier } = c.req.param();
    const passesUpdatedSinceParam = c.req.query("passesUpdatedSince");
    const passesUpdatedSince = passesUpdatedSinceParam
      ? Number(passesUpdatedSinceParam)
      : null;

    let query =
      "SELECT m.member_id as member_id, m.last_updated_at as last_updated_at " +
      "FROM registrations r JOIN members m ON m.member_id = r.serial_number " +
      "WHERE r.device_library_identifier = ? AND r.pass_type_identifier = ?";
    const params: (string | number)[] = [
      deviceLibraryIdentifier,
      passTypeIdentifier,
    ];
    if (passesUpdatedSince !== null && Number.isFinite(passesUpdatedSince)) {
      query += " AND m.last_updated_at > ?";
      params.push(passesUpdatedSince);
    }

    const { results } = await c.env.DB.prepare(query)
      .bind(...params)
      .all<{ member_id: string; last_updated_at: number }>();

    if (results.length === 0) {
      return c.body(null, 204);
    }

    const lastUpdated = Math.max(...results.map((r) => r.last_updated_at));
    return c.json({
      lastUpdated: String(lastUpdated),
      serialNumbers: results.map((r) => r.member_id),
    });
  },
);

/**
 * 4.3 Deliver Latest Pass Version. Serves from the Phase 3.3 R2 cache when
 * available; only pays the signing/ZIP cost (assemblePassBundle) on a
 * cache miss.
 */
passkit.get("/v1/passes/:passTypeIdentifier/:serialNumber", async (c) => {
  const { serialNumber } = c.req.param();

  const member = await getMember(c.env, serialNumber);
  if (
    !member ||
    !verifyPassAuthorization(c.req.header("authorization"), member.auth_token)
  ) {
    return c.text("Unauthorized", 401);
  }

  const ifModifiedSince = c.req.header("if-modified-since");
  if (ifModifiedSince) {
    const since = Date.parse(ifModifiedSince);
    if (!Number.isNaN(since) && member.last_updated_at <= since) {
      return c.body(null, 304);
    }
  }

  const passTypeIdentifier = c.env.PASSKIT_PASS_TYPE_IDENTIFIER;
  let bundle = await getCachedPass(
    c.env.ASSETS,
    passTypeIdentifier,
    serialNumber,
    member.last_updated_at,
  );
  if (!bundle) {
    const assets = await loadTemplateAssets(c.env.ASSETS);
    bundle = await assemblePassBundle(
      toMemberPassInput(member),
      passKitConfig(c.env),
      assets,
      signingCredentials(c.env),
    );
    await putCachedPass(
      c.env.ASSETS,
      passTypeIdentifier,
      serialNumber,
      member.last_updated_at,
      bundle,
    );
  }

  // See sha1Hex in generator.ts for why this narrowing is needed.
  return new Response(bundle as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.pkpass",
      "Last-Modified": new Date(member.last_updated_at).toUTCString(),
    },
  });
});

/** 4.4 Device Unregistration. */
passkit.delete(
  "/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber",
  async (c) => {
    const { deviceLibraryIdentifier, serialNumber } = c.req.param();

    const member = await getMember(c.env, serialNumber);
    if (
      !member ||
      !verifyPassAuthorization(c.req.header("authorization"), member.auth_token)
    ) {
      return c.text("Unauthorized", 401);
    }

    await c.env.DB.prepare(
      "DELETE FROM registrations WHERE device_library_identifier = ? AND serial_number = ?",
    )
      .bind(deviceLibraryIdentifier, serialNumber)
      .run();

    return c.text("OK", 200);
  },
);

/**
 * 4.5 Device Error Logging. No auth per Apple's spec -- devices send these
 * precisely when something (including auth) is already broken.
 */
passkit.post("/v1/log", async (c) => {
  let body: { logs?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.text("Bad Request: invalid JSON body", 400);
  }

  const logs = Array.isArray(body.logs) ? body.logs : [];
  for (const message of logs) {
    const text = String(message);
    console.error("PassKit device log", { message: text });
    await c.env.DB.prepare(
      "INSERT INTO pass_device_logs (log_level, message) VALUES ('error', ?)",
    )
      .bind(text)
      .run();
  }

  return c.text("OK", 200);
});

export default passkit;
