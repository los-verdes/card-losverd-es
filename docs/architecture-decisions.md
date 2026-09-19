# Architecture decisions

Why this service is built the way it is. These decisions were made before the
rewrite began and have not changed since, which is why they live here rather
than in the migration plan: the plan describes work that is nearly finished,
while these outlive it.

Decisions made during the build are recorded where they apply -- in code
comments at the point they matter, and in the issues that settled them.
This file is for the few that shaped everything else.

## The context these decisions share

This service supports a small local community non-profit, the Los Verdes
supporters group. It is self-funded, with no organisational budget and no
formal SLA.

That is not a disclaimer; it is the premise most of what follows rests on.
Reducing the number of things that must be understood, paid for and kept
running is weighted more heavily than avoiding all user-visible disruption.
Where those two conflict, simplicity wins, and the plan says so explicitly
rather than pretending the trade does not exist.

Two things are deliberately exempt, because they cannot be regenerated:

- **Legacy membership-card records**, enough to keep QR codes already printed
  and installed still verifiable.
- **Members' historical `member_since` dates**, because the Squarespace order
  history they were computed from exists only in the legacy Postgres database
  -- the Squarespace account itself is gone.

Everything else is treated as a refreshable cache of BigCommerce, which is
what makes the rest of the architecture affordable.

## Cloudflare Workers, D1 and R2, rather than staying on GCP

The legacy stack ran on Cloud Run, Cloud SQL PostgreSQL, a load balancer, a
VPC connector, Firestore, Pub/Sub and Cloud Scheduler. Each of those is a
component to configure, pay for and reason about, and several exist only to
let the others talk to each other -- the VPC connector and the connection
pooler are infrastructure whose entire purpose is working around Cloud SQL's
connection limits.

The replacement is Workers, D1 and R2, with Queues for asynchronous work and
Cron Triggers for scheduled jobs. It removes the connection-limit problem
rather than managing it, has no idle cost, and caps the monthly bill in the
region of $0-5.

| Concern | Legacy | Now | Why |
| :--- | :--- | :--- | :--- |
| Runtime | Python/Flask on Cloud Run | TypeScript/Hono on Workers | No containers to maintain, no cold-start cost |
| Datastore | Cloud SQL PostgreSQL | D1 (SQLite) | No connection limits, poolers or VPC connectors; no idle cost |
| Assets and passes | Container disk / GCS | R2 | S3-compatible, no egress fees |
| Async work | Pub/Sub to a second Cloud Run app | One Queue per environment, plus a DLQ | One deployable instead of two |
| Scheduled jobs | Cloud Scheduler to Pub/Sub | Cron Triggers | Direct equivalent, no extra service |
| Card images | `html2image`, a headless browser | Satori plus `@resvg/resvg-wasm` | Runs inside a Worker as JS and WASM, in milliseconds |
| Observability | Cloud Logging | Workers Logs | Included, no configuration |

The card-image row is the one that was genuinely uncertain. "No Workers
equivalent for a headless browser" looked like a blocker until Satori and
resvg turned out to render the card as pure JS and WASM at negligible cost.
It required re-authoring the template against Satori's CSS subset --
flexbox, no grid, no arbitrary selectors -- rather than porting the existing
Jinja and SCSS as-is.

## TypeScript rather than Python

Cloudflare does run Python Workers, so staying in Python was a real option
and would have avoided a rewrite. It was rejected for one specific reason.

Python Workers run on Pyodide, which supports pure-Python and
PyEmscripten-compatible packages. Native C-extension packages are not
supported -- and that is how essentially every mainstream Python
cryptography library is built. Apple PassKit requires PKCS#7 pass signing,
which was the single highest-uncertainty piece of the whole migration.

So the choice was not "rewrite risk versus no rewrite risk". It was rewrite
risk against fighting an immature crypto ecosystem on precisely the hardest
part of the project. TypeScript's equivalents on Workers -- `node-forge`,
`jose`, `node:crypto` under `nodejs_compat` -- are mature and were proven in
a spike before the rest of the work began.

This is a judgement about where Cloudflare's platform maturity sits today,
not a general position on rewriting working software in another language.

## One DNS cutover, rather than a gradual migration

The obvious alternative was a strangler-fig migration: route production
traffic endpoint by endpoint until nothing is left on the old stack. That
was rejected in favour of building the replacement completely, validating it
without production traffic, and moving `card.losverd.es` in a single step.

The reason is the premise above. A gradual migration means a long period in
which both stacks are live, both must be maintained, and every question
about behaviour has two possible answers. For a volunteer-run project, that
state costs more than a brief, scheduled disruption does.

It also keeps rollback genuinely simple. Until the new stack takes real
production writes, reverting is a DNS change, and the legacy stack has been
kept syncing in the meantime so nothing is lost by going back. See
[`cutover.md`](cutover.md) for how that is carried out and what the rollback
actually restores.

## Two environments, not one

Originally there was to be a single environment, on the grounds that fewer
things are simpler -- production, reachable at a `workers.dev` hostname
until cutover. That was reversed on 2026-09-17.

The reason was the BigCommerce sandbox store. Exercising order ingestion
against real orders meant either pointing production at a test store, which
defeats the purpose, or having somewhere else to point. Staging is that
somewhere: its own Worker, D1 database, R2 bucket and queues, provisioned by
the same Terraform through `for_each` over an environments map rather than
duplicated resource blocks.

The cost is real and worth stating: named Wrangler environments inherit
neither variables nor bindings, so every setting is spelled out twice, and
`just check-wrangler-envs` exists in CI because that duplication drifts
silently otherwise -- and because an environment accidentally pointing at a
production resource is the failure that would matter most.
