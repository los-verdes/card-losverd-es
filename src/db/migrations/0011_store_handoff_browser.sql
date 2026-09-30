-- Which browser first used each storefront token (#38). The store hands out
-- the same `current.jwt` for its whole 15 minutes, so a second "Membership
-- card" (or "Connect") in that time arrives with a token already spent. It is
-- honoured only from the browser that spent it: that browser was given a
-- random marker in a cookie, and only the marker's SHA-256 is kept here, for
-- as long as the token row itself. Rows from before this have none, and so
-- match no browser.
ALTER TABLE store_handoff_tokens ADD COLUMN browser_hash TEXT;
