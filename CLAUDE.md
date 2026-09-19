# Project conventions for `card-losverd-es`

## Warning triage policy

Don't let warnings slide by unaddressed — whether they show up in CI logs, `wrangler dev` output, test runs, or any other console output encountered while working on this project. For each one encountered:

- If it's small and safe to fix on the spot, fix it immediately as part of the current change.
- Otherwise, log it as a tracked follow-up below rather than letting it go unrecorded.

### Tracked follow-ups

- **`npm warn install-scripts`** for `esbuild`/`workerd`'s postinstall scripts (seen in every `npm ci`) -- npm's newer install-scripts review feature flagging that these two deps have postinstall scripts not yet explicitly allow-listed. Scripts still ran (the build/deploy that follows depends on esbuild's platform binary and workerd's runtime being installed, and both have worked), so this is advisory, not blocking. Could be silenced by explicitly trusting both via `npm install-scripts approve esbuild workerd` (or equivalent `package.json` config) once someone's deliberately reviewed what those scripts do.
- Node's own internal `[DEP0040]` (`punycode`) and `[DEP0169]` (`url.parse()`) `DeprecationWarning`s that show up periodically in CI logs are coming from inside third-party tools' own dependency chains (npm itself and/or the GitHub Actions toolkit libraries), not from anything in this repo -- not actionable here, just noting so they aren't mistaken for something of ours to fix.
- **workerd `Called .text() on an HTTP body which does not appear to be text ... "application/x-www-form-urlencoded"`** (seen in `test/auth/authjs.spec.ts` runs, and expected in production tail logs on Auth.js sign-in POSTs and Apple's `form_post` callback). Comes from `@auth/core`'s own `getBody()` (`lib/utils/web.js`) reading URL-encoded form bodies with `req.text()`. Harmless -- URL-encoded bodies are plain ASCII, and workerd's text-content-type heuristic just doesn't include that type. Not fixable in this repo; revisit if an `@auth/core` release reads form bodies via `formData()` instead.
- **Vitest `Sourcemap for ".../node_modules/oauth4webapi/build/index.js" points to missing source files`** (test output only). `oauth4webapi` (an `@auth/core` dependency) publishes a sourcemap referencing sources it doesn't ship. Cosmetic; not ours to fix.

## No real personal data in development

This repository is public, and the members are real people. Never put real
personal data of any kind into anything written for this project: test
fixtures, seed or scratch SQL, throwaway scripts, comments, docs, commit
messages, PR or issue text, or examples quoted in chat. That covers names,
email addresses, Slack handles, order and customer ids, device ids, and
anything else tied to a person.

This matters most when real data has been supplied for reference (a report
export, a database dump, a production log, a real Wallet pass). Use it to
understand shape and behavior only; do not copy values out of it, even into
local files that will never be committed.

Use obviously synthetic values that keep the real format: `example.com`
addresses, invented names, a 24-character hex string for a Squarespace order
id, `1001_bc` for a BigCommerce order key.
