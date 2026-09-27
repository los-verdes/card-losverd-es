import { describe, expect, it } from "vitest";
import { reasonsNotToReplace, type DocState } from "../../scripts/lib/provenanceGdocGuard";

const OWNER = "owner@example.com";
const BOT = "provenance-gdoc@example-project.iam.gserviceaccount.com";

function state(overrides: Partial<DocState> = {}): DocState {
  return {
    owners: [OWNER],
    comments: [],
    revisions: [
      { id: "1", lastModifyingUser: { emailAddress: OWNER } },
      { id: "2", lastModifyingUser: { emailAddress: BOT } },
    ],
    ...overrides,
  };
}

describe("reasonsNotToReplace", () => {
  it("allows a Doc touched only by its owner and the refresher", () => {
    expect(reasonsNotToReplace(state(), BOT)).toEqual([]);
  });

  it("matches addresses whatever their case", () => {
    const doc = state({ owners: ["Owner@Example.com"], revisions: [{ id: "1", lastModifyingUser: { emailAddress: OWNER } }] });
    expect(reasonsNotToReplace(doc, BOT.toUpperCase())).toEqual([]);
  });

  it("refuses while any comment is there, resolved or not", () => {
    const reasons = reasonsNotToReplace(state({ comments: [{ resolved: true }, { resolved: false }] }), BOT);
    expect(reasons).toEqual([
      "it has 2 comments (1 open); carry them back to the repository, then delete them in the Doc",
    ]);
  });

  it("ignores deleted comments", () => {
    expect(reasonsNotToReplace(state({ comments: [{ deleted: true }] }), BOT)).toEqual([]);
  });

  it("refuses a revision by anyone else, naming them", () => {
    const doc = state({
      revisions: [
        { id: "1", lastModifyingUser: { emailAddress: OWNER } },
        { id: "7", modifiedTime: "2026-09-25T12:00:00Z", lastModifyingUser: { emailAddress: "editor@example.com" } },
      ],
    });
    expect(reasonsNotToReplace(doc, BOT)).toEqual(["revision 7 (2026-09-25T12:00:00Z) is by editor@example.com"]);
  });

  it("refuses a revision whose author Drive does not identify by address", () => {
    const doc = state({
      revisions: [
        { id: "8", lastModifyingUser: { displayName: "Sam Example" } },
        { id: "9" },
      ],
    });
    expect(reasonsNotToReplace(doc, BOT)).toEqual([
      "revision 8 is by Sam Example",
      "revision 9 is by an author Drive does not name",
    ]);
  });

  it("gives every reason at once", () => {
    const doc = state({
      comments: [{}],
      revisions: [{ id: "3", lastModifyingUser: { emailAddress: "editor@example.com" } }],
    });
    expect(reasonsNotToReplace(doc, BOT)).toHaveLength(2);
  });
});
