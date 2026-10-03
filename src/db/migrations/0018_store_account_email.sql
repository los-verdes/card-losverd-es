-- The email of the store account connected to a user (#38), as the store's
-- own signed `current.jwt` stated it, refreshed each time the member comes
-- through "Membership card". Shown back to that member on their card page, so
-- they can tell which store account is connected. Never matched against
-- anything: `users.bigcommerce_id` alone decides whose account it is.
ALTER TABLE users ADD COLUMN bigcommerce_email TEXT;
