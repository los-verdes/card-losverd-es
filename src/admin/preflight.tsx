/**
 * The readiness page: everything the Worker can check about its
 * own deployment, plus the steps that still need a person and a phone.
 *
 * Deliberately a page rather than a script. The checks worth running are the
 * ones only the deployed Worker can answer -- does this key parse, is that
 * object in R2, does the Wallet class exist under this issuer -- and reaching
 * them from outside would mean granting some external caller deep visibility
 * into an environment's configuration. An admin session is credential enough
 * and already exists, so no new shared token is introduced to hold two
 * environments apart.
 *
 * `no-store`, like the other admin pages: this one enumerates an
 * environment's configuration state, which is not something to leave in a
 * shared cache.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import type { Env } from "../index";
import { requireAdmin, type AuthEnv } from "../middleware/auth";
import { AdminPage } from "./layout";
import {
  DEVICE_REPORT_WINDOW_DAYS,
  recentDeviceReports,
  type DeviceReportGroup,
} from "../ops/deviceReports";
import {
  MANUAL_STEPS,
  runPreflightChecks,
  type CheckGroup,
  type CheckStatus,
} from "./preflightChecks";

const STATUS_STYLE: Record<CheckStatus, { label: string; colour: string }> = {
  ok: { label: "OK", colour: "var(--success)" },
  warn: { label: "WARN", colour: "var(--warn)" },
  fail: { label: "FAIL", colour: "var(--danger)" },
  skip: { label: "OFF", colour: "var(--muted)" },
};

const rowStyle = "padding: 0.35rem 0.6rem; text-align: left; border-bottom: 1px solid var(--rule); vertical-align: top";

const Group: FC<{ group: CheckGroup }> = ({ group }) => (
  <section style="margin-bottom: 1.75rem">
    <h2 style="font-size: 1.1rem; margin-bottom: 0.4rem">{group.title}</h2>
    <table style="border-collapse: collapse; width: 100%">
      <tbody>
        {group.results.map((result) => (
          <tr>
            <td style={`${rowStyle}; width: 4.5rem; font-weight: 600; color: ${STATUS_STYLE[result.status].colour}`}>
              {STATUS_STYLE[result.status].label}
            </td>
            <td style={`${rowStyle}; width: 16rem`}>{result.name}</td>
            <td style={rowStyle}>{result.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </section>
);

/**
 * What the "Wallet passes reporting failures" signal is counting. Shown here
 * because a count with no way to see the messages behind it is a number
 * nobody can act on -- which is how a week of registration failures went
 * unread once already.
 */
const DeviceReports: FC<{ groups: DeviceReportGroup[] }> = ({ groups }) => (
  <section style="margin-bottom: 1.75rem">
    <h2 style="font-size: 1.1rem; margin-bottom: 0.4rem">What phones reported</h2>
    <p style="margin-top: 0; color: var(--muted)">
      Sent by Wallet itself when a pass will not register or update, over the last{" "}
      {DEVICE_REPORT_WINDOW_DAYS} days. Serial numbers, device identifiers and URLs are masked, so
      messages about the same fault group together.
    </p>
    {groups.length === 0 ? (
      <p style="margin: 0">No phone has reported a problem.</p>
    ) : (
      <table data-sortable style="border-collapse: collapse; width: 100%">
        <thead>
          <tr>
            <th style={`${rowStyle}; width: 5rem`}>Count</th>
            <th style={`${rowStyle}; width: 12rem`}>Last seen</th>
            <th style={rowStyle}>What the phone said</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr>
              <td style={rowStyle}>{group.count}</td>
              <td style={rowStyle} data-sort={String(group.lastSeen)}>
                {new Date(group.lastSeen).toISOString().replace("T", " ").slice(0, 16)}
              </td>
              <td style={`${rowStyle}; font-family: ui-monospace, monospace; font-size: 0.85em`}>{group.shape}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </section>
);

const preflight = new Hono<AuthEnv & { Bindings: Env }>();

preflight.use("*", requireAdmin);
preflight.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

preflight.get("/", async (c) => {
  const [groups, deviceReports] = await Promise.all([
    runPreflightChecks(c.env, c.req.url),
    recentDeviceReports(c.env),
  ]);
  const failures = groups.flatMap((group) => group.results).filter((result) => result.status === "fail").length;
  const warnings = groups.flatMap((group) => group.results).filter((result) => result.status === "warn").length;

  return c.html(
    <AdminPage title="Readiness">
      <p style="margin-top: 0">
        Checks this Worker can run against its own deployment, for the environment serving this
        page. Read-only: nothing here creates a class, uploads an asset, or applies a migration.
        {" "}
        <strong>
          {failures} failing, {warnings} warning.
        </strong>
      </p>
      {groups.map((group) => (
        <Group group={group} />
      ))}
      <DeviceReports groups={deviceReports} />
      <section>
        <h2 style="font-size: 1.1rem; margin-bottom: 0.4rem">Still needs a person</h2>
        <p style="margin-top: 0; color: var(--muted)">
          No code above can do these. Work down the list on the environment serving this page.
          Ticking is just for keeping your place -- nothing is saved, and a reload starts over.
        </p>
        <ul class="checklist">
          {MANUAL_STEPS.map((step) => (
            <li>
              <label>
                <input type="checkbox" />
                <span>{step}</span>
              </label>
            </li>
          ))}
        </ul>
      </section>
    </AdminPage>,
  );
});

export default preflight;
