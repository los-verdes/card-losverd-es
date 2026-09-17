import { Hono } from "hono";
import type { Env } from "../index";
import { getApplePassBundle, getMemberById } from "../member/artifacts";
import { verifyPassAuthorization } from "../middleware/auth";

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

    const member = await getMemberById(c.env, serialNumber);
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
 * 4.3 Deliver Latest Pass Version. `getApplePassBundle` serves from the
 * Phase 3.3 R2 cache when available and only signs on a miss.
 */
passkit.get("/v1/passes/:passTypeIdentifier/:serialNumber", async (c) => {
  const { serialNumber } = c.req.param();

  const member = await getMemberById(c.env, serialNumber);
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

  const bundle = await getApplePassBundle(c.env, member);

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

    const member = await getMemberById(c.env, serialNumber);
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
