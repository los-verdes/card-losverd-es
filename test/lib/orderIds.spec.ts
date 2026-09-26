import { describe, expect, it } from "vitest";
import { fullOrderIdTitle, shortOrderId } from "../../src/lib/orderIds";

describe("shortOrderId", () => {
  it("shows a Squarespace order id by its ends", () => {
    expect(shortOrderId("0cd5ad745fbc40fd95697470")).toBe("0cd5ad…7470");
  });

  it.each(["1001", "123456789012", "1001_bc"])("leaves %s, as short as a BigCommerce id, as it is", (id) => {
    expect(shortOrderId(id)).toBe(id);
  });
});

describe("fullOrderIdTitle", () => {
  it("is the whole id when the shown one is shortened", () => {
    expect(fullOrderIdTitle("0cd5ad745fbc40fd95697470")).toBe("0cd5ad745fbc40fd95697470");
  });

  it("is nothing for an id shown whole", () => {
    expect(fullOrderIdTitle("1001")).toBeUndefined();
  });
});
