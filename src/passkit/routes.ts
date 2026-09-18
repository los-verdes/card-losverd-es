import { Hono } from "hono";
import type { Env } from "../index";
import { getApplePassBundle, getMemberById } from "../member/artifacts";
import { consumeRateLimit, type RateLimitRule } from "../lib/rateLimit";
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
 * Per caller, because this endpoint cannot be authenticated and writes to the
 * database. A real device logs when something is broken, in bursts of a few
 * messages; twenty requests an hour is far above that and far below anything
 * that costs us.
 */
export const LOG_RATE_LIMIT: RateLimitRule = {
  name: "passkit-log:ip",
  limit: 20,
  windowSeconds: 60 * 60,
};

/** Apple sends a handful; anything beyond this is not a device reporting a fault. */
export const MAX_LOG_ENTRIES = 20;

/** Long enough for a stack trace, short enough that a row cannot be a payload. */
export const MAX_LOG_MESSAGE_LENGTH = 2_000;

/**
 * 4.5 Device Error Logging. No auth per Apple's spec -- devices send these
 * precisely when something (including auth) is already broken.
 *
 * Which makes it the one endpoint here that anyone at all can write to the
 * database through, so what it accepts is bounded on every axis: how often a
 * caller may post, how many entries one post may carry, and how long each may
 * be. Without those, a single request could write until D1 refused it, and
 * repeat; the table has no expiry, and every entry also costs a line in
 * Workers Logs.
 *
 * The response is 200 regardless, short of malformed JSON. A device that has
 * just failed to do something is not helped by being told its complaint was
 * rejected, and Apple would only retry.
 */
passkit.post("/v1/log", async (c) => {
  let body: { logs?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.text("Bad Request: invalid JSON body", 400);
  }

  const limit = await consumeRateLimit(
    c.env.DB,
    LOG_RATE_LIMIT,
    c.req.header("cf-connecting-ip") ?? "unknown",
  );
  if (!limit.allowed) {
    console.warn("PassKit device log: rate limit reached, dropping");
    return c.text("OK", 200);
  }

  const submitted = Array.isArray(body.logs) ? body.logs : [];
  const kept = submitted.slice(0, MAX_LOG_ENTRIES);
  if (submitted.length > kept.length) {
    console.warn("PassKit device log: entries beyond the cap were dropped", {
      submitted: submitted.length,
      kept: kept.length,
    });
  }

  const statements = kept.map((message) => {
    const text = String(message).slice(0, MAX_LOG_MESSAGE_LENGTH);
    console.error("PassKit device log", { message: text });
    return c.env.DB.prepare(
      "INSERT INTO pass_device_logs (log_level, message) VALUES ('error', ?)",
    ).bind(text);
  });
  // One round trip rather than one per entry, which also keeps a single
  // request well clear of D1's per-invocation query limit.
  if (statements.length > 0) {
    await c.env.DB.batch(statements);
  }

  return c.text("OK", 200);
});

export default passkit;
