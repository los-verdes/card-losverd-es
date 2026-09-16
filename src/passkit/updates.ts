import type { Env } from "../index";
import { sendPassUpdatePush, type ApnsConfig } from "./apns";

export interface PassUpdateSummary {
  /** True when APNs isn't configured, so nothing was attempted. */
  skipped: boolean;
  sent: number;
  unregistered: number;
  failed: number;
}

function apnsConfig(env: Env): ApnsConfig | null {
  if (!env.APNS_KEY_ID || !env.APNS_PRIVATE_KEY_PEM) {
    return null;
  }
  return {
    teamId: env.PASSKIT_TEAM_IDENTIFIER,
    keyId: env.APNS_KEY_ID,
    privateKeyPem: env.APNS_PRIVATE_KEY_PEM,
    topic: env.PASSKIT_PASS_TYPE_IDENTIFIER,
  };
}

/**
 * Tells every device with this pass installed to fetch the latest version
 * (plan Phase 4.7). Call after a pass-visible change to a member; the pass
 * itself is regenerated lazily, since the R2 cache is keyed to
 * `last_updated_at`.
 *
 * Never throws for push failures -- callers are sync jobs, which shouldn't
 * fail (and retry the whole sync) because one device couldn't be reached.
 * Devices APNs reports as unregistered are removed, which cascades to their
 * registrations.
 */
export async function notifyPassUpdated(
  env: Env,
  serialNumber: string,
): Promise<PassUpdateSummary> {
  const summary: PassUpdateSummary = {
    skipped: false,
    sent: 0,
    unregistered: 0,
    failed: 0,
  };
  const config = apnsConfig(env);
  if (!config) {
    console.warn(
      "notifyPassUpdated(): APNS_KEY_ID / APNS_PRIVATE_KEY_PEM not configured, skipping pass update push",
    );
    return { ...summary, skipped: true };
  }

  const { results: devices } = await env.DB.prepare(
    `SELECT d.device_library_identifier, d.push_token
     FROM registrations r JOIN devices d ON d.device_library_identifier = r.device_library_identifier
     WHERE r.serial_number = ? AND r.pass_type_identifier = ?`,
  )
    .bind(serialNumber, config.topic)
    .all<{ device_library_identifier: string; push_token: string }>();

  for (const device of devices) {
    let result;
    try {
      result = await sendPassUpdatePush(config, device.push_token);
    } catch (err) {
      result = {
        status: "failed",
        httpStatus: 0,
        reason: String(err),
      } as const;
    }

    if (result.status === "sent") {
      summary.sent++;
    } else if (result.status === "unregistered") {
      summary.unregistered++;
      await env.DB.prepare(
        "DELETE FROM devices WHERE device_library_identifier = ?",
      )
        .bind(device.device_library_identifier)
        .run();
    } else {
      summary.failed++;
      console.error("APNs pass update push failed", {
        serialNumber,
        deviceLibraryIdentifier: device.device_library_identifier,
        httpStatus: result.httpStatus,
        reason: result.reason,
      });
    }
  }
  return summary;
}
