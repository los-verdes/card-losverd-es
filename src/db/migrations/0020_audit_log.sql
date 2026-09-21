-- An append-only record of the decisions people make about memberships.
--
-- The tables that hold those decisions hold the *current* state, which means
-- undoing one erases the fact that it happened. Lifting an expulsion deletes
-- the `banned_people` row; clearing a chosen name deletes the
-- `member_display_names` row; setting a new "member since" overwrites the old
-- one. The note explaining why, and the person who decided it, go with them.
--
-- That is the wrong shape for the question these records exist to answer.
-- "Why does this person's card say that" and "who decided this, and when" are
-- asked about things that are no longer true as often as things that are --
-- most often precisely when somebody is appealing a decision that has since
-- been reversed.
--
-- So this table is written alongside those, never instead of them: they stay
-- the fast answer to "what is true now", and this is the slow answer to "what
-- happened". Nothing deletes from it.
--
-- `action` is a coarse verb rather than a table name, because what a reader
-- wants is the decision, not which row moved. `detail` is one human-readable
-- line, already composed, so a reader is never asked to reconstruct meaning
-- from columns. Both are stored rather than derived: a log that changes
-- meaning when the code around it changes is not a log.
--
-- Sent emails are recorded here too. `card_emails` exists to stop a second
-- copy going out and is keyed on the order for that reason, so it cannot
-- answer "has anything been sent to this person, and when".
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,                     -- e.g. membership.revoked, card.emailed
    subject_email TEXT,                       -- lower-cased; the person it was about
    -- Deliberately not a foreign key to `users`: an actor who is later deleted
    -- must not quietly become NULL here, which is exactly the fact this table
    -- exists to keep. The address is stored as it was at the time.
    actor_email TEXT,                         -- lower-cased; null when nobody was signed in
    detail TEXT NOT NULL,                     -- one line, composed at the time
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

-- The two questions asked of it: one person's history, and what happened
-- lately. `id` tie-breaks within a millisecond, which D1 can produce.
CREATE INDEX IF NOT EXISTS idx_audit_log_subject ON audit_log(subject_email, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_recent ON audit_log(id DESC);
