/**
 * The pre-cutover readiness page: everything the Worker can check about its
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
  MANUAL_STEPS,
  runPreflightChecks,
  type CheckGroup,
  type CheckStatus,
} from "./preflightChecks";

const STATUS_STYLE: Record<CheckStatus, { label: string; colour: string }> = {
  ok: { label: "OK", colour: "#137333" },
  warn: { label: "WARN", colour: "#a15c00" },
  fail: { label: "FAIL", colour: "#b3261e" },
  skip: { label: "OFF", colour: "#5f6368" },
};

const rowStyle = "padding: 0.35rem 0.6rem; text-align: left; border-bottom: 1px solid #ddd; vertical-align: top";

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

const preflight = new Hono<AuthEnv & { Bindings: Env }>();

preflight.use("*", requireAdmin);
preflight.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

preflight.get("/", async (c) => {
  const groups = await runPreflightChecks(c.env, c.req.url);
  const failures = groups.flatMap((group) => group.results).filter((result) => result.status === "fail").length;
  const warnings = groups.flatMap((group) => group.results).filter((result) => result.status === "warn").length;

  return c.html(
    <AdminPage title="Pre-cutover readiness">
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
      <section>
        <h2 style="font-size: 1.1rem; margin-bottom: 0.4rem">Still needs a person</h2>
        <p style="margin-top: 0; color: #5f6368">
          No code above can do these. Work down the list on the environment serving this page.
        </p>
        <ul>
          {MANUAL_STEPS.map((step) => (
            <li style="margin-bottom: 0.3rem">{step}</li>
          ))}
        </ul>
      </section>
    </AdminPage>,
  );
});

export default preflight;
