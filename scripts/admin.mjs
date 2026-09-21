// Granting, revoking and listing admin access for an environment.
//
// Admin is a flag on the `users` row, checked on every admin request. This
// replaces a hand-typed `UPDATE` that failed in two ways without saying so:
//
//   - A person who has never signed in has no `users` row yet, so the update
//     matched nothing and looked exactly like it had worked.
//   - Addresses are stored lower-cased, so the same update with a capital in
//     it also matched nothing, and also looked like it had worked.
//
// The first is now refused with the reason; the second is handled by
// lower-casing the address before it is used. Every grant and revocation is
// written to the audit log, alongside the membership decisions already there
// -- who can see and change members' records is the kind of thing somebody
// asks about later.
//
//   node scripts/admin.mjs <env> list
//   node scripts/admin.mjs <env> grant  <email>
//   node scripts/admin.mjs <env> revoke <email>
//
// See `just admin-list`, `just admin-grant` and `just admin-revoke`.

import { ENVIRONMENTS, runD1, sqlSafeEmail } from "./lib/d1.ts";

function fail(message) {
  console.error(`admin: ${message}`);
  process.exit(1);
}

const [env, command, rawEmail] = process.argv.slice(2);
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
if (!rawEmail) fail(`${command} needs the address the person signs in with`);
const email = sqlSafeEmail(rawEmail);
if (!email) fail(`${JSON.stringify(rawEmail)} does not look like an email address`);

const { rows } = d1(`SELECT id, is_admin FROM users WHERE email = '${email}'`);
if (rows.length === 0) {
  fail(
    `nobody has signed in to ${env} as ${email} yet, so there is no account to change. ` +
      "Ask them to sign in once, then run this again.",
  );
}

const granting = command === "grant";
if ((rows[0].is_admin === 1) === granting) {
  console.log(`${email} ${granting ? "is already an admin" : "is not an admin"} in ${env}. Nothing to do.`);
  process.exit(0);
}

const { changes } = d1(
  `UPDATE users SET is_admin = ${granting ? 1 : 0} WHERE email = '${email}'`,
);
if (changes !== 1) fail(`expected to change one row and changed ${changes}; check ${env} by hand`);

// Recorded after the change rather than before it, so the log never claims a
// grant that did not happen. The actor is left empty: this ran from a
// terminal, and a name here would be a guess.
d1(
  `INSERT INTO audit_log (action, subject_email, actor_email, detail)
   VALUES ('${granting ? "admin.granted" : "admin.revoked"}', '${email}', NULL,
           'From the command line, with just admin-${command}')`,
);

console.log(
  granting
    ? `${email} is now an admin in ${env}. It takes effect on their next request; no sign-out needed.`
    : `${email} is no longer an admin in ${env}. It takes effect on their next request.`,
);
