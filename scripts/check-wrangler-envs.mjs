// Guards wrangler.toml's named environments (e.g. `[env.staging]`) against the
// two ways they go wrong, using Wrangler's own config resolution (the same
// view `wrangler deploy --env <name>` gets):
//
// 1. Drift: named environments inherit neither vars nor bindings from the
//    top-level (production) config, so a var or binding added only at the top
//    level silently disappears from the environment. (A Worker once shipped
//    with no bindings at all this way -- see the migration plan's Handoff note.)
// 2. Leaks: an environment accidentally pointing at a production resource
//    (D1 database, R2 bucket, queue) or reusing production's Worker name.
//
// Usage: node scripts/check-wrangler-envs.mjs   (or `just check-wrangler-envs`)

import { experimental_readRawConfig, unstable_readConfig } from "wrangler";

const CONFIG = "wrangler.toml";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function read(env) {
  return unstable_readConfig({ config: CONFIG, env }, { hideWarnings: true });
}

function summarize(config) {
  return {
    name: config.name,
    vars: Object.keys(config.vars).sort(),
    d1Bindings: config.d1_databases.map((d) => d.binding).sort(),
    r2Bindings: config.r2_buckets.map((b) => b.binding).sort(),
    queueProducerBindings: config.queues.producers.map((q) => q.binding).sort(),
    queueConsumerCount: config.queues.consumers.length,
    d1: config.d1_databases.flatMap((d) => [d.database_name, d.database_id]),
    buckets: config.r2_buckets.map((b) => b.bucket_name),
    queues: [
      ...config.queues.producers.map((q) => q.queue),
      ...config.queues.consumers.flatMap((q) => [q.queue, q.dead_letter_queue]),
    ].filter(Boolean),
    d1Ids: config.d1_databases.map((d) => d.database_id),
  };
}

function difference(a, b) {
  return a.filter((x) => !b.includes(x));
}

const production = summarize(read(undefined));
const envNames = Object.keys(
  experimental_readRawConfig({ config: CONFIG }).rawConfig.env ?? {},
);
const problems = [];

for (const [label, config] of [["production", production]]) {
  for (const id of config.d1Ids) {
    if (!UUID.test(id)) problems.push(`${label}: D1 database_id "${id}" isn't a real database ID`);
  }
}

for (const envName of envNames) {
  const env = summarize(read(envName));
  const where = `env.${envName}`;

  for (const key of ["vars", "d1Bindings", "r2Bindings", "queueProducerBindings"]) {
    const missing = difference(production[key], env[key]);
    const extra = difference(env[key], production[key]);
    if (missing.length) problems.push(`${where}: missing ${key} declared for production: ${missing.join(", ")}`);
    if (extra.length) problems.push(`${where}: ${key} not declared for production: ${extra.join(", ")}`);
  }
  if (env.queueConsumerCount !== production.queueConsumerCount) {
    problems.push(`${where}: ${env.queueConsumerCount} queue consumers vs. production's ${production.queueConsumerCount}`);
  }

  if (env.name === production.name) problems.push(`${where}: reuses production's Worker name "${env.name}"`);
  for (const key of ["d1", "buckets", "queues"]) {
    const shared = env[key].filter((x) => production[key].includes(x));
    if (shared.length) problems.push(`${where}: shares production ${key}: ${shared.join(", ")}`);
  }
  for (const id of env.d1Ids) {
    if (!UUID.test(id)) problems.push(`${where}: D1 database_id "${id}" isn't a real database ID`);
  }
}

if (problems.length) {
  console.error(`wrangler.toml environment check failed:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(`wrangler.toml environments OK: production + ${envNames.join(", ") || "(none)"}`);
