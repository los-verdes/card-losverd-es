/**
 * Whether the shared Google Doc copy of the provenance document may be
 * overwritten with a fresh one (scripts/provenance-gdoc-push.mjs).
 *
 * Replacing a Doc's content drops every comment's anchor and every edit made
 * in it, so it is safe only while the Doc holds nothing but what this
 * repository put there: no comments, resolved or not, and no revision by
 * anyone except the Doc's owner and the account that refreshes it. Anything
 * else means somebody has engaged with the Doc, and a person should carry
 * what they said back to the repository before it is replaced.
 */

export interface DocComment {
  deleted?: boolean;
  resolved?: boolean;
  author?: { displayName?: string };
}

export interface DocRevision {
  id: string;
  modifiedTime?: string;
  lastModifyingUser?: { emailAddress?: string; displayName?: string };
}

export interface DocState {
  /** The Doc's owners' addresses. */
  owners: string[];
  comments: DocComment[];
  revisions: DocRevision[];
}

/**
 * Every reason not to replace the Doc; empty when it is safe. `refresher` is
 * the address of the account doing the replacing, whose own earlier
 * revisions are expected.
 */
export function reasonsNotToReplace(state: DocState, refresher: string): string[] {
  const reasons: string[] = [];

  const comments = state.comments.filter((comment) => !comment.deleted);
  if (comments.length > 0) {
    const open = comments.filter((comment) => !comment.resolved).length;
    reasons.push(
      `it has ${comments.length} comment${comments.length === 1 ? "" : "s"} (${open} open); ` +
        "carry them back to the repository, then delete them in the Doc",
    );
  }

  const allowed = new Set([...state.owners, refresher].map((address) => address.toLowerCase()));
  for (const revision of state.revisions) {
    const author = revision.lastModifyingUser;
    const address = author?.emailAddress?.toLowerCase();
    if (address && allowed.has(address)) continue;
    const who = author?.emailAddress ?? author?.displayName ?? "an author Drive does not name";
    reasons.push(`revision ${revision.id}${revision.modifiedTime ? ` (${revision.modifiedTime})` : ""} is by ${who}`);
  }

  return reasons;
}
