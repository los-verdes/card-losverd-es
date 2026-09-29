-- The card theme a member has chosen (#333, piece 4).
--
-- Keyed on address, like member_display_names and for the same reason: the
-- `members` row is rebuilt from the orders on every sync, so a choice stored
-- there would be reverted at the next one. Absent means nobody has chosen,
-- and the card is drawn in the member's default theme
-- (src/themes/eligibility.ts). A choice the member may no longer use -- a
-- theme since withdrawn -- is kept but not drawn, so it takes effect again if
-- the theme returns.
--
-- Unlike member_since_overrides this table has no triggers: the code that
-- writes it bumps members.last_updated_at and notifies the member's passes
-- itself (src/themes/choice.ts), as setting a card name does.
CREATE TABLE IF NOT EXISTS member_card_themes (
    email TEXT PRIMARY KEY,                   -- lower-cased, matching members.email
    theme_id TEXT NOT NULL,                   -- a CardTheme id (src/themes/cardTheme.ts)
    source TEXT NOT NULL CHECK (source IN ('member', 'admin')),
    set_by INTEGER REFERENCES users(id) ON DELETE SET NULL, -- who chose it
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
