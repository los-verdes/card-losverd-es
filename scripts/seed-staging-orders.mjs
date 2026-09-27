/**
 * Fills the staging BigCommerce store with synthetic orders shaped like
 * production's, so a full resync on staging rehearses the real one (#347).
 *
 * Every order is invented: made-up names, `example.com` addresses (a domain
 * reserved for examples, which staging's EMAIL_RECIPIENT_ALLOWLIST would not
 * email anyway), and a staff note saying what it is. Nothing is copied from
 * production; only its shape is matched, from aggregate counts taken
 * 2026-09-26:
 *
 * - 6,203 membership orders among order ids 100..10,630, so about 4,400
 *   orders for something else, each of which a resync still has to open;
 * - by year 1,626 (2023, from February) / 1,180 / 1,693 / 1,706 (2026 to
 *   date), heavily seasonal, February by far the busiest month;
 * - statuses: Shipped 75.4%, Incomplete 22.8%, Awaiting Fulfillment 0.8%,
 *   Refunded 0.4%, Partially Refunded and Cancelled 0.2% each, Partially
 *   Shipped 0.1%;
 * - orders per member from 1 (514 people) to 27 (one), about 2,000 people;
 * - 5 orders carrying more than one membership.
 *
 * The orders are generated from a fixed seed, so every run plans the same
 * ones, and created oldest first, so the store gives them ids in date order
 * as production's are. Creation can stop and resume (`--from`).
 *
 * Usage:
 *   node scripts/seed-staging-orders.mjs                  # the plan; no requests
 *   node scripts/seed-staging-orders.mjs --try-one        # create one order, read it back
 *   node scripts/seed-staging-orders.mjs --create [--from N] [--limit N]
 *
 * The token is an API account on the staging store with Orders: modify, from
 * BIGCOMMERCE_SEED_TOKEN or ~/.config/.wrangler/bigcommerce-staging-orders-token.
 * It refuses any store but staging's (from wrangler.toml).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// -- Which store ------------------------------------------------------------

const wrangler = readFileSync("wrangler.toml", "utf8");
const productionHash = /^BIGCOMMERCE_STORE_HASH = "([^"]+)"/m.exec(wrangler)?.[1];
const stagingHash = /\[env\.staging\.vars\][\s\S]*?^BIGCOMMERCE_STORE_HASH = "([^"]+)"/m.exec(wrangler)?.[1];
if (!stagingHash || !productionHash || stagingHash === productionHash) {
  console.error("Could not tell staging's store from production's in wrangler.toml; refusing.");
  process.exit(2);
}

// -- The plan ---------------------------------------------------------------

/** A small seeded generator (mulberry32), so every run plans the same orders. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = random(20260926);
const pick = (items) => items[Math.floor(rand() * items.length)];
function weighted(table) {
  const total = table.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rand() * total;
  for (const [value, weight] of table) {
    if ((roll -= weight) < 0) return value;
  }
  return table.at(-1)[0];
}

const MEMBERSHIP_ORDERS = 6203;
const OTHER_ORDERS = 4400;
const MULTI_MEMBERSHIP_ORDERS = 5;
const FIRST_DAY = Date.parse("2023-02-01T00:00:00Z");
const LAST_DAY = Date.parse("2026-09-26T00:00:00Z");

const ORDERS_PER_MEMBER = [
  [1, 514], [2, 376], [3, 381], [4, 390], [5, 107], [6, 94], [7, 89], [8, 32],
  [9, 9], [10, 3], [11, 4], [12, 5], [16, 1], [27, 1],
];
// BigCommerce status ids, weighted by production's mix.
const STATUSES = [
  [{ id: 2, name: "Shipped" }, 4677],
  [{ id: 0, name: "Incomplete" }, 1417],
  [{ id: 11, name: "Awaiting Fulfillment" }, 52],
  [{ id: 4, name: "Refunded" }, 27],
  [{ id: 14, name: "Partially Refunded" }, 12],
  [{ id: 5, name: "Cancelled" }, 12],
  [{ id: 3, name: "Partially Shipped" }, 8],
];
// Orders per calendar month, production's seasonality.
const MONTHS = [225, 2596, 982, 463, 577, 257, 286, 175, 425, 83, 71, 65];
const YEARS = [[2023, 1626], [2024, 1180], [2025, 1693], [2026, 1706]];

const FIRST_NAMES = ["Alex", "Sam", "Jordan", "Casey", "Riley", "Morgan", "Taylor", "Jamie", "Avery", "Quinn",
  "Drew", "Rowan", "Parker", "Reese", "Skyler", "Dana", "Emery", "Hayden", "Kendall", "Logan"];
// Invented, so nobody mistakes one of these for a real member.
const LAST_NAMES = ["Sampleton", "Testwell", "Mockford", "Fixtureson", "Seedwell", "Demoway", "Placerton",
  "Exampleby", "Trialsby", "Stagingham"];

/** A day in a given year, drawn with production's seasonality, never after LAST_DAY. */
function dayIn(year) {
  for (;;) {
    const month = weighted(MONTHS.map((weight, i) => [i, year === 2023 && i === 0 ? 0 : weight]));
    const day = 1 + Math.floor(rand() * 28);
    const at = Date.UTC(year, month, day, 12 + Math.floor(rand() * 10), Math.floor(rand() * 60));
    if (at >= FIRST_DAY && at <= LAST_DAY) return at;
  }
}

function person(n) {
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  return { first, last, email: `${first}.${last}.${String(n).padStart(4, "0")}@example.com`.toLowerCase() };
}

function plan() {
  const orders = [];
  let people = 0;

  // Membership orders: people with production's spread of order counts, each
  // order dated independently from production's year and month mix, so the
  // totals per year match by construction.
  while (orders.length < MEMBERSHIP_ORDERS) {
    const who = person(++people);
    const count = weighted(ORDERS_PER_MEMBER);
    for (let i = 0; i < count; i++) {
      orders.push({ at: dayIn(weighted(YEARS)), who, membership: true, status: weighted(STATUSES), quantity: 1 });
    }
  }
  orders.splice(MEMBERSHIP_ORDERS);
  for (let i = 0; i < MULTI_MEMBERSHIP_ORDERS; i++) {
    const order = orders[Math.floor(rand() * orders.length)];
    order.quantity = 2;
  }

  // Everything else the store sells, bought by members and others alike.
  for (let i = 0; i < OTHER_ORDERS; i++) {
    const who = rand() < 0.5 ? orders[Math.floor(rand() * MEMBERSHIP_ORDERS)].who : person(++people);
    orders.push({ at: dayIn(weighted(YEARS)), who, membership: false, status: weighted(STATUSES), quantity: 1 });
  }

  return { orders: orders.sort((a, b) => a.at - b.at), people };
}

function orderBody(order) {
  const product = order.membership
    ? { name: "Los Verdes Annual Membership", sku: "LOSV-MEM-0001", price: 30 }
    : { name: "Synthetic Scarf", sku: "SEED-MERCH-SCARF", price: 25 };
  return {
    customer_id: 0,
    status_id: order.status.id,
    date_created: new Date(order.at).toUTCString(),
    staff_notes: "Synthetic order for staging load tests (scripts/seed-staging-orders.mjs); not a real sale.",
    billing_address: {
      first_name: order.who.first,
      last_name: order.who.last,
      street_1: "1 Example Street",
      city: "Austin",
      state: "Texas",
      zip: "78701",
      country_iso2: "US",
      email: order.who.email,
    },
    products: [
      {
        name: product.name,
        sku: product.sku,
        quantity: order.quantity,
        price_inc_tax: product.price,
        price_ex_tax: product.price,
      },
    ],
  };
}

// -- Talking to the store -----------------------------------------------------

let cachedToken;
function token() {
  if (cachedToken) return cachedToken;
  if (process.env.BIGCOMMERCE_SEED_TOKEN) return (cachedToken = process.env.BIGCOMMERCE_SEED_TOKEN.trim());
  const file = join(homedir(), ".config/.wrangler/bigcommerce-staging-orders-token");
  if (existsSync(file)) return (cachedToken = readFileSync(file, "utf8").trim());
  console.error("No token: set BIGCOMMERCE_SEED_TOKEN, or put one in ~/.config/.wrangler/bigcommerce-staging-orders-token.");
  process.exit(2);
}

const API = `https://api.bigcommerce.com/stores/${stagingHash}/v2`;

async function request(path, init = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { "X-Auth-Token": token(), Accept: "application/json", "Content-Type": "application/json" },
    });
    // The store's rate limit is shared; wait out the window it names.
    if (res.status === 429 && attempt < 10) {
      const wait = Number(res.headers.get("X-Rate-Limit-Time-Reset-Ms") ?? 5000);
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 30_000)));
      continue;
    }
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} answered ${res.status}: ${(await res.text()).slice(0, 400)}`);
    return res.status === 204 ? null : res.json();
  }
}

// -- Main -------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : Number(args[i + 1]);
};

const { orders, people } = plan();

if (!flag("--create") && !flag("--try-one")) {
  const byYear = {};
  const byStatus = {};
  for (const order of orders) {
    const year = new Date(order.at).getUTCFullYear();
    byYear[year] = byYear[year] ?? { membership: 0, other: 0 };
    byYear[year][order.membership ? "membership" : "other"]++;
    if (order.membership) byStatus[order.status.name] = (byStatus[order.status.name] ?? 0) + 1;
  }
  console.log(`Plan for staging's store (${stagingHash}): ${orders.length} orders for ${people} synthetic people.`);
  console.table(byYear);
  console.log("Membership orders by status:");
  console.table(byStatus);
  console.log(`Orders carrying two memberships: ${orders.filter((order) => order.quantity > 1).length}`);
  console.log(`First: ${new Date(orders[0].at).toISOString()}, last: ${new Date(orders.at(-1).at).toISOString()}`);
  console.log("Example:", JSON.stringify(orderBody(orders.find((order) => order.membership)), null, 2));
  process.exit(0);
}

if (flag("--try-one")) {
  const order = orders.find((candidate) => candidate.membership && candidate.status.id === 2);
  const created = await request("/orders", { method: "POST", body: JSON.stringify(orderBody(order)) });
  const products = await request(`/orders/${created.id}/products`);
  console.log(
    `Created order ${created.id}: status "${created.status}", date_created ${created.date_created}, ` +
      `line item SKU ${products.map((product) => product.sku).join(", ")}.`,
  );
  console.log("If the SKU is LOSV-MEM-0001 and the date is in the past, the store takes these orders as planned.");
  process.exit(0);
}

const from = option("--from", 0);
const limit = option("--limit", orders.length);
const progressFile = join(homedir(), ".config/.wrangler/seed-staging-orders.progress");
const to = Math.min(orders.length, from + limit);
console.log(`Creating orders ${from}..${to - 1} of ${orders.length} in staging's store (${stagingHash}).`);
for (let i = from; i < to; i++) {
  await request("/orders", { method: "POST", body: JSON.stringify(orderBody(orders[i])) });
  writeFileSync(progressFile, `${i + 1}\n`);
  if ((i + 1) % 100 === 0) console.log(`  ${i + 1} created (${new Date(orders[i].at).toISOString().slice(0, 10)})`);
}
console.log(`Done: ${to - from} created. Resume with --from ${to}.`);
