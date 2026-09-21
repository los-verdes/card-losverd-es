import { describe, expect, it } from "vitest";
import { displayOrderNumber } from "../../src/member/orderHistory";

describe("the order number a member sees", () => {
  it("is BigCommerce's own id, unchanged", () => {
    // What the Merch Team sees in the store's admin, and what is printed on
    // the member's receipt, so the two can be matched without translation.
    expect(displayOrderNumber("1001")).toBe("1001");
  });

  it("leaves a Squarespace-era id alone", () => {
    expect(displayOrderNumber("5f00000000000000000000a1")).toBe("5f00000000000000000000a1");
  });

  it("still reads a row carrying the previous site's `_bc` suffix as the bare id", () => {
    // Neither the sync nor the legacy export writes these any more. This is
    // the tolerance for anything that slipped past both: a
    // member should never see an internal convention on their own history.
    expect(displayOrderNumber("1001_bc")).toBe("1001");
  });
});
