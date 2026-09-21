// Carries the previous site's unsubscribes over to Cloudflare Email Service's
// suppression list, so nobody who asked to stop getting card emails starts
// getting them again because the sender changed.
//
// The previous site sent card emails under a SendGrid unsubscribe group, and
// SendGrid kept the list of who left it. This reads that group's list and
// adds each address to the account's suppression list -- the same list the
// unsubscribe link in today's card emails writes to (src/email/suppressions.ts).
//
// Safe to run more than once: an address already on the list is left alone.
// It never prints an address, only counts; the addresses are real people's.
//
// Usage:
//   SENDGRID_API_KEY=... CLOUDFLARE_ACCOUNT_ID=... EMAIL_SUPPRESSIONS_API_TOKEN=... \
//     node scripts/sendgrid-import-unsubscribes.mjs [--group 29631] [--dry-run]
//   just sendgrid-import-unsubscribes [--dry-run]     (pulls all three from 1Password)

import { findSuppressions, suppressAddress } from "../src/email/suppressions.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const groupIndex = args.indexOf("--group");
// The group the previous site's card emails were sent under.
const group = groupIndex >= 0 ? args[groupIndex + 1] : "29631";

const env = {
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  EMAIL_SUPPRESSIONS_API_TOKEN: process.env.EMAIL_SUPPRESSIONS_API_TOKEN,
};
const sendgridKey = process.env.SENDGRID_API_KEY;

if (!sendgridKey || !env.CLOUDFLARE_ACCOUNT_ID || !env.EMAIL_SUPPRESSIONS_API_TOKEN) {
  console.error(
    "sendgrid-import-unsubscribes: set SENDGRID_API_KEY, CLOUDFLARE_ACCOUNT_ID and EMAIL_SUPPRESSIONS_API_TOKEN",
  );
  process.exit(2);
}

const response = await fetch(`https://api.sendgrid.com/v3/asm/groups/${encodeURIComponent(group)}/suppressions`, {
  headers: { Authorization: `Bearer ${sendgridKey}` },
});
if (!response.ok) {
  console.error(
    `SendGrid answered ${response.status} for unsubscribe group ${group}: ${await response.text()}\n` +
      "The key needs Suppressions read access. If it has already been deleted, there is nothing left to read the list with.",
  );
  process.exit(1);
}
const addresses = [...new Set((await response.json()).map((address) => String(address).trim().toLowerCase()))];
console.log(`SendGrid unsubscribe group ${group}: ${addresses.length} address(es).`);

let added = 0;
let present = 0;
let failed = 0;
for (const address of addresses) {
  try {
    if ((await findSuppressions(env, address)).length > 0) {
      present += 1;
    } else if (!dryRun) {
      await suppressAddress(env, address, `Unsubscribed on the previous site (SendGrid group ${group})`);
      added += 1;
    } else {
      added += 1;
    }
  } catch (error) {
    failed += 1;
    // The reason, not the address.
    console.error(`  one address failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(
  `${dryRun ? "Would add" : "Added"} ${added}; already on the list ${present}; failed ${failed}.` +
    (dryRun ? " Nothing was changed (--dry-run)." : ""),
);
process.exit(failed > 0 ? 1 : 0);
