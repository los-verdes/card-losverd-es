// Checks a Cloudflare API token against the API surfaces this project's
// Terraform and Deploy workflow actually use, so a narrowed token can be
// tried before it is put somewhere a failure breaks a deploy
// (los-verdes/card-losverd-es#15).
//
// The token in use today is deliberately broad, and the list of what it
// really needs has been a guess written down in terraform/README.md. The
// point of this script is to turn that guess into something a person can run
// in ten seconds against a candidate token.
//
// What it can and cannot tell you
// -------------------------------
// Every probe below is a read. A read succeeding proves the token carries the
// permission group at all, which is the mistake this catches: a group left
// out entirely, which fails at `terraform apply` or mid-deploy. A read
// succeeding does NOT prove the group is scoped to Edit rather than Read --
// only a real deploy proves that, and staging is where to prove it.
//
// Reads also mean running this is safe: it creates nothing, changes nothing,
// and needs no confirmation.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/cloudflare-token-check.mjs
//   just cloudflare-token-check          (pulls both from 1Password)

// Overridable so the branches below can be exercised against a stub without a
// live token -- the authorized paths are otherwise only reachable by someone
// holding the real credential, which is the wrong thing to need in order to
// check that an error message is right.
const API =
  process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4";

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!token || !accountId) {
  console.error(
    "cloudflare-token-check: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID",
  );
  process.exit(2);
}

// Each probe names the permission group to add in the Cloudflare dashboard
// when it fails, and what stops working without it -- so a failure says what
// to do rather than only what went wrong.
const PROBES = [
  {
    name: "D1",
    path: `/accounts/${accountId}/d1/database?per_page=1`,
    group: "Account > D1 > Edit",
    usedBy: "terraform apply (cloudflare_d1_database), just db-migrate-remote",
  },
  {
    name: "R2",
    path: `/accounts/${accountId}/r2/buckets?per_page=1`,
    group: "Account > Workers R2 Storage > Edit",
    usedBy: "terraform apply (cloudflare_r2_bucket), just r2-upload-templates",
  },
  {
    name: "Queues",
    path: `/accounts/${accountId}/queues?per_page=1`,
    group: "Account > Queues > Edit",
    usedBy: "terraform apply (cloudflare_queue), wrangler deploy (queue consumers)",
  },
  {
    name: "Workers Scripts",
    path: `/accounts/${accountId}/workers/scripts`,
    group: "Account > Workers Scripts > Edit",
    usedBy: "wrangler deploy",
  },
];

async function call(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  // Cloudflare answers with a JSON envelope even for errors, but a proxy or
  // an outage can still hand back HTML.
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** Cloudflare's first error message, which is the useful half of the envelope. */
function reason({ status, body }) {
  const error = body?.errors?.[0];
  if (!error) return `HTTP ${status}`;
  const chained = error.error_chain?.[0]?.message;
  return `HTTP ${status}: ${error.message}${chained ? ` (${chained})` : ""}`;
}

// Cloudflare has two kinds of API token, verified at two endpoints: a
// user-owned token at /user/tokens/verify, and an account-owned token at
// /accounts/{id}/tokens/verify. A group-owned account is exactly where a
// narrowed token might be created as account-owned, so try both before
// concluding anything about the token itself.
let verify = await call("/user/tokens/verify");
if (verify.status === 401 || verify.status === 403) {
  const accountVerify = await call(`/accounts/${accountId}/tokens/verify`);
  if (accountVerify.body?.success) {
    verify = accountVerify;
  }
}
if (verify.status === 400) {
  // 6111, "Invalid format for Authorization header" -- the value isn't
  // shaped like a token at all, so it is usually a quoting or op:// mistake
  // rather than a permissions one.
  console.error(`cloudflare-token-check: the token is malformed -- ${reason(verify)}`);
  process.exit(1);
}
if (verify.status === 401) {
  console.error(`cloudflare-token-check: the token is invalid or expired -- ${reason(verify)}`);
  process.exit(1);
}
if (!verify.body?.success) {
  console.error(`cloudflare-token-check: could not verify the token -- ${reason(verify)}`);
  process.exit(1);
}

// Both credentials this project holds for Cloudflare can now expire, and an
// expiry is a deploy that breaks on a date nobody is looking at. Thirty days
// is the same notice the Apple pass certificate gets, for the same reason:
// long enough to act calmly, short enough not to become background noise.
const EXPIRY_WARN_DAYS = 30;

function daysUntil(when) {
  return Math.floor((when.getTime() - Date.now()) / 86_400_000);
}

/**
 * Reports how long a credential has left, and whether that is a problem.
 * Returns true when it is past due, so the caller can fail on it.
 */
function reportExpiry(label, iso) {
  if (!iso) {
    console.log(`     ${label}: no expiry set`);
    return false;
  }
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) {
    console.log(`     ${label}: expiry recorded as ${JSON.stringify(iso)}, which is not a date`);
    return false;
  }
  const left = daysUntil(when);
  const on = when.toISOString().slice(0, 10);
  if (left < 0) {
    console.log(`     ${label}: EXPIRED on ${on}`);
    return true;
  }
  console.log(
    `     ${label}: valid until ${on} (${left} days)${left <= EXPIRY_WARN_DAYS ? " -- renew it" : ""}`,
  );
  return false;
}

console.log("Credentials:");
const apiTokenExpired = reportExpiry("API token", verify.body?.result?.expires_on);
// The state credential is an R2 access key pair, not a bearer token, so there
// is no endpoint to ask and the date has to be recorded alongside it. Absent
// is reported rather than assumed fine: "no expiry set" and "nobody wrote the
// date down" look the same from here, and only one of them is safe.
const stateExpired = reportExpiry(
  "Terraform state credential",
  process.env.TF_STATE_TOKEN_EXPIRES_ON,
);
console.log("");

const results = [];
for (const probe of PROBES) {
  const response = await call(probe.path);
  // 404 with code 7003 means the path didn't route, which for these
  // account-scoped endpoints means the account id is wrong -- worth telling
  // apart from a permission the token lacks, since the fix is different.
  const badAccount =
    response.status === 404 && response.body?.errors?.[0]?.code === 7003;
  results.push({
    ...probe,
    ok: response.body?.success === true,
    badAccount,
    why: reason(response),
  });
}

if (results.some((r) => r.badAccount)) {
  console.error(
    `cloudflare-token-check: account ${accountId} doesn't look right -- Cloudflare wouldn't route to it.\n` +
      "  Check CLOUDFLARE_ACCOUNT_ID before reading anything below as a permissions problem.",
  );
  process.exit(1);
}

for (const r of results) {
  console.log(`${r.ok ? "OK  " : "MISS"} ${r.name}${r.ok ? "" : ` -- ${r.why}`}`);
}

const missing = results.filter((r) => !r.ok);
if (missing.length) {
  console.error(
    `\ncloudflare-token-check: ${missing.length} of ${results.length} permission groups missing. Add in the Cloudflare dashboard:\n` +
      missing.map((r) => `  - ${r.group}\n      needed by: ${r.usedBy}`).join("\n"),
  );
  process.exit(1);
}

if (apiTokenExpired || stateExpired) {
  console.error(
    "\ncloudflare-token-check: a credential has expired. Every permission group " +
      "above can still be listed correctly and the deploy will still fail.",
  );
  process.exit(1);
}

console.log(
  `\nAll ${results.length} permission groups present on account ${accountId}.\n` +
    "Note this proves each group is granted, not that it is granted at Edit\n" +
    "rather than Read -- deploy to staging to prove that.",
);
