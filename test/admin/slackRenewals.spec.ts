import { describe, expect, it } from "vitest";
import { splitLapsedByRenewal } from "../../src/admin/slackRenewals";
import type { RenewalRow } from "../../src/minibc/renewals";

const lapsed = (email: string) => ({
  email,
  first_name: null,
  last_name: null,
  expires_on: "2025-05-01T00:00:00Z",
  slack_id: "U1",
  slack_name: null,
});

const subscription = (id: number, email: string, fields: Partial<RenewalRow>): RenewalRow => ({
  subscription_id: id,
  status: "active",
  signup_on: null,
  next_payment_on: null,
  paused_on: null,
  cancelled_on: null,
  order_id: null,
  store_customer_id: null,
  sku: "LOSV-MEM-0001",
  member_email: email,
  member_id: "LV-1",
  first_name: null,
  last_name: null,
  display_name: null,
  expiration_date: "2025-05-01",
  ...fields,
});

describe("splitLapsedByRenewal", () => {
  const TODAY = "2026-06-01";

  it("lets an active subscription speak for a member who also has a cancelled one", () => {
    const split = splitLapsedByRenewal(
      [lapsed("pat@example.com")],
      [
        subscription(1, "pat@example.com", { status: "inactive", cancelled_on: "2024-01-01" }),
        subscription(2, "pat@example.com", { next_payment_on: "2026-06-03" }),
      ],
      TODAY,
    );

    expect(split.renewalOn).toHaveLength(1);
    expect(split.renewalOn[0].renewal).toContain("automatic renewal is still on");
    expect(split.renewalOff).toEqual([]);
  });

  it("counts a paused renewal with the cancelled ones", () => {
    const split = splitLapsedByRenewal(
      [lapsed("pat@example.com")],
      [subscription(1, "pat@example.com", { status: "paused", paused_on: "2025-04-01" })],
      TODAY,
    );

    expect(split.renewalOff.map((row) => row.renewal)).toEqual(["Automatic renewal paused since Apr 1, 2025"]);
  });

  it("matches addresses whatever their case, and leaves a subscription with no member out", () => {
    const split = splitLapsedByRenewal(
      [lapsed("pat@example.com"), lapsed("sam@example.com")],
      [subscription(1, "Pat@Example.com", {}), subscription(2, null as unknown as string, {})],
      TODAY,
    );

    expect(split.renewalOn.map((row) => row.email)).toEqual(["pat@example.com"]);
    expect(split.noRenewal).toEqual([{ ...lapsed("sam@example.com"), renewal: null }]);
  });
});
