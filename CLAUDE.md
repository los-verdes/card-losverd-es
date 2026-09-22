# Project conventions for `card-losverd-es`

## Warning triage policy

Don't let warnings slide by unaddressed — whether they show up in CI logs, `wrangler dev` output, test runs, or any other console output encountered while working on this project. For each one encountered:

- If it's small and safe to fix on the spot, fix it immediately as part of the current change.
- Otherwise, log it as a tracked follow-up below rather than letting it go unrecorded.

### Tracked follow-ups

- **`esbuild` and `workerd` postinstall scripts are allow-listed** in `package.json` (`allowScripts`), by name rather than pinned version so routine bumps don't re-raise npm's install-scripts warning. Reviewed 2026-09-19: both scripts (workerd's is a copy of esbuild's) locate the platform binary shipped as an optional dependency, run it once to check its version, and only if it is missing download that exact pinned version from `registry.npmjs.org`. Nothing else runs. If either package ever changes what its install script does, `npm install-scripts ls` is the place to look, and the entry should be re-reviewed rather than assumed.
- **`hint: Using 'master' as the name for the initial branch`** (three times per Deploy run, once per job). Printed by `actions/checkout`'s own `git init` on the runner before it fetches `main`; nothing in this repository runs `git init`, and the checked-out branch is unaffected. Not ours to fix.
- Node's own internal `[DEP0040]` (`punycode`) and `[DEP0169]` (`url.parse()`) `DeprecationWarning`s that show up periodically in CI logs are coming from inside third-party tools' own dependency chains (npm itself and/or the GitHub Actions toolkit libraries), not from anything in this repo -- not actionable here, just noting so they aren't mistaken for something of ours to fix.
- **workerd `Called .text() on an HTTP body which does not appear to be text ... "application/x-www-form-urlencoded"`** (seen in `test/auth/authjs.spec.ts` runs, and expected in production tail logs on Auth.js sign-in POSTs and Apple's `form_post` callback). Comes from `@auth/core`'s own `getBody()` (`lib/utils/web.js`) reading URL-encoded form bodies with `req.text()`. Harmless -- URL-encoded bodies are plain ASCII, and workerd's text-content-type heuristic just doesn't include that type. Not fixable in this repo; revisit if an `@auth/core` release reads form bodies via `formData()` instead.
- **Vitest `Sourcemap for ".../node_modules/oauth4webapi/build/index.js" points to missing source files`** (test output only). `oauth4webapi` (an `@auth/core` dependency) publishes a sourcemap referencing sources it doesn't ship. Cosmetic; not ours to fix.

## What to call things, and who to write for

**Los Verdes is an independent supporters' group, never a "club".** Write "the
group", "Los Verdes", or "supporters' group". The word is wrong twice over:
Los Verdes is not one, and "the club" already means Austin FC, whom the group
is independent of. Background:
<https://www.losverdesatx.org/about-us>.

Two internal bodies come up in this project, both proper nouns:

- The **Membership Committee** is the group's conduct body -- effectively its
  HR function: the Code of Conduct, keeping spaces inclusive, reviewing
  reports, conflict resolution. They are **consulted on everything** the
  membership rules touch, and **responsible** for the subset that settles a
  person's standing, such as revoking a membership or expelling somebody.
  Use the [code of conduct](https://www.losverdesatx.org/code-of-conduct)'s
  own words for those two: it says the Committee may "revoke or temporarily
  suspend that person's membership", and names expulsion from Los Verdes as
  the heaviest outcome of its sanction process. Do not coin a synonym.
- The **Merch Team** (`#team-merch`) administer the BigCommerce storefront and
  answer `merchteam@losverdesatx.org`, where support requests about
  memberships and orders arrive. They are the primary audience for
  documentation about where card data comes from.

Do not assume the Membership Committee administers memberships because of the
name -- that is the Merch Team. Documentation written for the wrong one of
these is documentation nobody reads.

## The provenance document is the specification

`docs/membership-card-provenance.md` is the central specification for
everything else in this repository. It is the project's main interface to the
group's stakeholders -- the Merch Team who field members' questions, and the
Membership Committee who are consulted on anything that settles a person's
standing -- so it is the source of truth, and the rest of the repository
aligns with it rather than the other way round.

In practice:

- A change to how membership works is described there, not just implemented.
  Where that document and the code disagree, treat it as a defect and correct
  whichever is wrong, rather than leaving the document to catch up later.
- Other documents that restate its rules -- `docs/reporting.md` and
  `docs/bigcommerce-ingestion.md` both do -- must not contradict it. When one
  change makes several documents disagree, make the provenance document
  correct first and bring the others into line with it.
- It is not purely descriptive. It records what the code does today *and*
  exists to invite feedback and proposals to change that, which is what the
  "Decisions worth confirming" section is for. Do not trim the open questions
  out of it for not being implementation.
- Its diagrams keep labels to a few words per line on purpose. Mermaid no
  longer grows a box to fit its text (mermaid-js/mermaid#7354), so a long
  label is silently clipped when GitHub renders it; detail goes in the prose.

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
id, `1001` for a BigCommerce order key.

## Never email members as a side effect

A membership card is emailed only because a member asked for it, or because
a new order completed. It is never sent as a side effect of a backfill, a
resync, or a data import or reload -- those touch every member at once,
and getting it wrong means mailing hundreds of people who did not ask.

Three guards in `src/email/newOrder.ts` enforce that, each sufficient alone,
and a fourth (`EMAIL_RECIPIENT_ALLOWLIST`) limits who an environment may
email at all. Read the comment at the top of that file before changing
anything on the send path, and treat a change that makes a bulk path capable
of sending as a defect regardless of what it enables.

## Working in this repository

**Never merge a pull request without explicit approval for that specific
PR.** Enabling auto-merge is the sanctioned exception, because the branch
ruleset requires a review from someone other than the last pusher, so a
human approval still stands between the branch and `main`.

**Automation acts as `verde-bot`, and that includes pushes.** GitHub takes
"last pusher" from whoever authenticated the push, not from the commit
author. `origin` is an SSH remote, so a plain `git push` authenticates as
the key's owner -- which makes the maintainer the last pusher on a PR he
then cannot approve. Push over HTTPS with the token inline, and never write
it into `.git/config`:

```bash
GH_TOKEN="$(gh auth token --hostname github.com --user verde-bot)" gh pr create ...
git push "https://verde-bot:$(gh auth token --hostname github.com --user verde-bot)@github.com/los-verdes/card-losverd-es.git" <branch>
```

`gh api repos/los-verdes/card-losverd-es/activity` reports the actor per
push, which is the field the ruleset reads.

**Check what already exists before starting.** More than one session has
built the same thing twice, having read a stale copy of the state. Re-fetch,
and check open PRs and remote branches touching the same files, before
writing code.

**Git work happens in a worktree**, not the main checkout. The stash stack
is shared across worktrees, so never use a bare `git stash` -- prefer a
temporary commit, or `git stash push -u -m "<tag>"` and recover the entry by
tag.

**Writing for other people to read.** Pull request descriptions are short
and telegraphic: what changed, anything surprising, anything the reviewer
must do. Everything in the repository and on GitHub -- issues, comments,
code comments, docs -- is written in the project's collective voice, without
naming an individual. Documentation describes what is implemented rather
than framing a question as closed: these documents exist to collect
feedback, and wording that sounds settled discourages it. A date still earns
its place in an issue or a code comment recording when something was
checked. Assign
`@jeffwecan` to any issue whose next step is his: a credential, a console
action, or an answer to a question the issue poses.

### Sharp edges worth knowing

- Auto-merge goes quiet when a PR conflicts, which looks identical to
  waiting for review. `gh pr list --json number,mergeStateStatus` shows
  `DIRTY`; re-enable it after resolving.
- Force-pushing a rebased branch by URL needs an explicit lease --
  `--force-with-lease=refs/heads/<branch>:<old sha>` -- because a bare one
  has no remote-tracking ref to compare against and is rejected as stale.
- `gh pr create` after a push by URL needs `--head <branch> --base main`.
- `gh pr edit` can fail with a Projects-classic GraphQL error;
  `gh api -X PATCH repos/.../pulls/N -F body=@file` works, and the same
  shape edits an issue body.
- **`just test` is not what CI runs.** CI runs `just test-coverage`, which
  enforces thresholds (95% statements/lines/functions, 90% branches) that a
  bare `vitest run` does not check. A green local suite can fail CI on
  coverage alone -- a new page with no spec of its own is the usual cause,
  since the threshold is global and one untested file drags it under. Run
  `just test-coverage` before pushing.
- **Delete from tables that reference `members` before `members` itself.**
  D1 enforces the foreign keys, so a spec whose `afterEach` deletes members
  while a `revoked_cards` or `expelled_people` row survives fails the delete,
  leaves the rows behind, and the *next* test collides with them. The symptom
  is a `UNIQUE constraint` error in a test that looks unrelated to the one
  that actually broke.
- `node:fs` does not work in the Workers test pool. To read source in a
  test, use `import.meta.glob("...", { query: "?raw", eager: true })`, which
  Vite inlines at transform time.
