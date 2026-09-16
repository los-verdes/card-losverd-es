# Project conventions for `card-losverd-es`

## Warning triage policy

Don't let warnings slide by unaddressed — whether they show up in CI logs, `wrangler dev` output, test runs, or any other console output encountered while working on this project. For each one encountered:

- If it's small and safe to fix on the spot, fix it immediately as part of the current change.
- Otherwise, log it as a tracked follow-up below rather than letting it go unrecorded.

### Tracked follow-ups

- **GitHub Actions CI: Node.js 20 deprecation warning.** CI annotates every run with `Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/checkout@v4, actions/setup-node@v4, extractions/setup-just@v2.` These are pinned major versions of third-party actions that haven't yet shipped a release targeting a newer Node runtime; GitHub is forcing them onto Node 24 in the meantime, so nothing is broken today. Revisit by bumping each action to its next major release once one is available that drops the Node 20 target, and remove this note once the annotation stops appearing.
