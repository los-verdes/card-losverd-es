-- When BigCommerce stops returning an order we hold (deleted, or otherwise
-- gone), record when we first noticed. See los-verdes/card-losverd-es#105.
--
-- Deliberately NOT part of COUNTS_AS_MEMBERSHIP. A flagged order keeps
-- conferring membership exactly as before; the flag only raises it for a
-- person to look at (decided 2026-09-18). Revoking someone's card on the
-- strength of one API response would turn a BigCommerce incident into mass
-- membership loss, and that trade is not worth making automatically.
--
-- Cleared by any later sync that fetches the order successfully, so a
-- transient 404 heals itself.
ALTER TABLE membership_orders ADD COLUMN missing_since INTEGER;

CREATE INDEX IF NOT EXISTS idx_membership_orders_missing
  ON membership_orders(missing_since);
