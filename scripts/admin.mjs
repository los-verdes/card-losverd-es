// Granting, revoking and listing admin access for an environment -- the
// command-line side of /admin/admins, and the way back in when nobody can
// reach that page (it works straight against D1).
//
// Admin is a flag on the `users` row, checked on every admin request. A grant
// creates the row if the person has never signed in; their first sign-in
// links to it by address and keeps the flag, so a group can be set up at once
// instead of waiting for each person to sign in. It has to be the address
// they will sign in with (their relay address, for Apple Hide My Email).
// Addresses are lower-cased first, because that is how they are stored.
// Every change is written to the audit log.
//
//   node scripts/admin.mjs <env> list
//   node scripts/admin.mjs <env> grant  <email> [<email> ...]
//   node scripts/admin.mjs <env> revoke <email> [<email> ...]
//
// See `just admin-list`, `just admin-grant` and `just admin-revoke`.

import { ENVIRONMENTS, runD1, sqlSafeEmail } from "./lib/d1.ts";

function fail(message) {
  console.error(`admin: ${message}`);
  process.exit(1);
}

const [env, command, ...rawEmails] = process.argv.slice(2);
if (!ENVIRONMENTS.includes(env)) fail(`first argument must be one of: ${ENVIRONMENTS.join(", ")}`);

/** One statement against this environment, failing with wrangler's reason. */
function d1(sql) {
  try {
    return runD1(env, sql);
  } catch (error) {
    return fail(error.message);
  }
}

if (command === "list") {
  const { rows } = d1(
    "SELECT email, created_at FROM users WHERE is_admin = 1 ORDER BY email",
  );
  if (rows.length === 0) {
    console.log(`No admins in ${env}. The readiness page and every admin screen are unreachable.`);
  } else {
    console.log(`Admins in ${env}:`);
    for (const row of rows) console.log(`  ${row.email}`);
  }
  process.exit(0);
}

if (command !== "grant" && command !== "revoke") {
  fail("second argument must be list, grant or revoke");
}
if (rawEmails.length === 0) fail(`${command} needs at least one address -- the one each person signs in with`);

// Checked all together before anything changes, so one typo in a list of ten
// does not leave the other nine half-done.
const emails = rawEmails.map((raw) => [raw, sqlSafeEmail(raw)]);
const bad = emails.filter(([, email]) => !email).map(([raw]) => JSON.stringify(raw));
if (bad.length > 0) fail(`not an email address: ${bad.join(", ")}. Nothing was changed.`);

const granting = command === "grant";
for (const [, email] of emails) {
  const { rows } = d1(`SELECT is_admin FROM users WHERE email = '${email}'`);
  const isAdmin = rows[0]?.is_admin === 1;
  if (isAdmin === granting) {
    console.log(`  ${email}: ${granting ? "already an admin" : "not an admin"}; nothing to do.`);
    continue;
  }

  if (granting) {
    d1(
      `INSERT INTO users (email, is_admin) VALUES ('${email}', 1)
       ON CONFLICT(email) DO UPDATE SET is_admin = 1, updated_at = unixepoch('subsec') * 1000`,
    );
  } else {
    d1(`UPDATE users SET is_admin = 0, updated_at = unixepoch('subsec') * 1000 WHERE email = '${email}'`);
  }

  // Recorded after the change rather than before it, so the log never claims
  // a change that did not happen. The actor is left empty: this ran from a
  // terminal, and a name here would be a guess.
  const beforeSignIn = granting && rows.length === 0;
  d1(
    `INSERT INTO audit_log (action, subject_email, actor_email, detail)
     VALUES ('${granting ? "admin.granted" : "admin.revoked"}', '${email}', NULL,
             'From the command line, with just admin-${command}${beforeSignIn ? ", before they had signed in" : ""}')`,
  );
  console.log(
    granting
      ? `  ${email}: now an admin${beforeSignIn ? " -- applies when they first sign in with this address" : ""}.`
      : `  ${email}: no longer an admin.`,
  );
}
console.log(`Done in ${env}. Changes take effect on each person's next request; no sign-out needed.`);
