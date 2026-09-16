# Project conventions for `card-losverd-es`

## Warning triage policy

Don't let warnings slide by unaddressed — whether they show up in CI logs, `wrangler dev` output, test runs, or any other console output encountered while working on this project. For each one encountered:

- If it's small and safe to fix on the spot, fix it immediately as part of the current change.
- Otherwise, log it as a tracked follow-up below rather than letting it go unrecorded.

### Tracked follow-ups

- **GitHub Actions CI: Node.js 20 deprecation warning.** Every workflow run annotates with `Node.js 20 is deprecated...`, naming whichever third-party actions that run currently uses. As of `deploy.yml` gaining `hashicorp/setup-terraform@v3` (PR #16), the deploy run's list is `actions/checkout@v4, actions/setup-node@v4, cloudflare/wrangler-action@v3, extractions/setup-just@v2, hashicorp/setup-terraform@v3`. These are pinned major versions of third-party actions that haven't yet shipped a release targeting a newer Node runtime; GitHub is forcing them onto Node 24 in the meantime, so nothing is broken today. Revisit by bumping each action to its next major release once one is available that drops the Node 20 target, and remove this note once the annotation stops appearing on every workflow.
- **`npm warn deprecated eslint@9.39.5`** (seen in every CI run that does `npm ci`). Upstream eslint 9.39.5 is past its support window per eslint.org's version-support page. Not urgent -- CI still passes -- but an eslint major/minor bump is worth scheduling deliberately (flat-config or rule behavior could shift) rather than doing reactively later.
- **`npm warn install-scripts`** for `esbuild`/`workerd`'s postinstall scripts (seen in every `npm ci`) -- npm's newer install-scripts review feature flagging that these two deps have postinstall scripts not yet explicitly allow-listed. Scripts still ran (the build/deploy that follows depends on esbuild's platform binary and workerd's runtime being installed, and both have worked), so this is advisory, not blocking. Could be silenced by explicitly trusting both via `npm install-scripts approve esbuild workerd` (or equivalent `package.json` config) once someone's deliberately reviewed what those scripts do.
- Node's own internal `[DEP0040]` (`punycode`) and `[DEP0169]` (`url.parse()`) `DeprecationWarning`s that show up periodically in CI logs are coming from inside third-party tools' own dependency chains (npm itself and/or the GitHub Actions toolkit libraries), not from anything in this repo -- not actionable here, just noting so they aren't mistaken for something of ours to fix.
