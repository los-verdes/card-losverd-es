import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findSuppressions,
  isSuppressionListConfigured,
  suppressAddress,
  unsuppressAddress,
} from "../../src/email/suppressions";
import { fakeSuppressionList, type FakeSuppressionList } from "../fixtures/suppressionList";

const ENV = { CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef", EMAIL_SUPPRESSIONS_API_TOKEN: "test-token" };

function serve(list: FakeSuppressionList) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    return (await list.handle(input, init)) ?? new Response("unexpected", { status: 599 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the suppression list client", () => {
  it("is configured only with both the account and a token", () => {
    expect(isSuppressionListConfigured(ENV)).toBe(true);
    expect(isSuppressionListConfigured({ ...ENV, EMAIL_SUPPRESSIONS_API_TOKEN: undefined })).toBe(false);
    expect(isSuppressionListConfigured({ ...ENV, CLOUDFLARE_ACCOUNT_ID: "" })).toBe(false);
  });

  it("refuses to call the API unconfigured, naming what is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      findSuppressions({ ...ENV, EMAIL_SUPPRESSIONS_API_TOKEN: undefined }, "a@example.com"),
    ).rejects.toThrow(/EMAIL_SUPPRESSIONS_API_TOKEN/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("looks an address up by exact match, on this account, with the token", async () => {
    const list = fakeSuppressionList([{ id: "s1", email: "a@example.com", reason: "manual", read_only: false }]);
    const fetchSpy = serve(list);

    const rows = await findSuppressions(ENV, "A@Example.com");

    expect(rows.map((r) => r.id)).toEqual(["s1"]);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef/email/sending/suppressions?email=a%40example.com&per_page=100",
    );
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("adds an address once, however many times it is asked", async () => {
    const list = fakeSuppressionList();
    serve(list);

    await suppressAddress(ENV, "a@example.com", "note");
    await suppressAddress(ENV, "a@example.com", "note");

    expect(list.rows).toHaveLength(1);
    expect(list.requests.filter((r) => r.startsWith("POST"))).toHaveLength(1);
  });

  it("removes only the rows it may, leaving Cloudflare's own", async () => {
    const list = fakeSuppressionList([
      { id: "mine", email: "a@example.com", reason: "manual", read_only: false },
      { id: "theirs", email: "a@example.com", reason: "complaint", read_only: true },
    ]);
    serve(list);

    await unsuppressAddress(ENV, "a@example.com");

    expect(list.rows.map((r) => r.id)).toEqual(["theirs"]);
    expect(list.requests).toContain("DELETE /suppressions/mine");
  });

  it("says what the API said when it refuses", async () => {
    const list = fakeSuppressionList();
    list.failWith = "Authentication error";
    serve(list);

    await expect(findSuppressions(ENV, "a@example.com")).rejects.toThrow(
      "Cloudflare suppression list GET failed: Authentication error",
    );
  });

  it("falls back to the status when the answer is not the API's JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));

    await expect(findSuppressions(ENV, "a@example.com")).rejects.toThrow(/HTTP 502/);
  });
});
