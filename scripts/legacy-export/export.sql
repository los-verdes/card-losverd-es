-- One-time, read-only export from the legacy digital-membership Postgres
-- database. Emits a single JSON document; see ./README.md for how to run
-- it and load the result into D1.
--
-- Column semantics mirror the legacy SQLAlchemy models exactly:
--   * member_since: `User.member_since` = MIN(annual_membership.created_on),
--     over every order including test ones, because that is the date cards
--     show today. It can therefore predate the earliest exported order.
--   * display_names: the old site had its own name-change page
--     (`POST /edit-user-name`), so `users.fullname` is sometimes a name the
--     member chose rather than the one on their orders. Only the ones that
--     differ are exported; see the query for why.
--   * membership_cards: every card ever minted (one per membership period),
--     since any of them may still be out in the world as a QR code.
--   * membership_orders: every `annual_membership` row (BigCommerce *and*
--     Squarespace), for D1's `membership_orders` history table. This is the
--     only surviving record of Squarespace-era orders. `member_email` is the
--     linked user's current email, which can differ from the order's own.
--     An order's era comes from `channel_name`, never from the shape of its
--     id. The old app wrote `{id}_bc` for BigCommerce orders but its own
--     views and responses strip that suffix (`split_part(order_id, '_', 1)`),
--     so what the column holds and what a copy of it shows can differ; a
--     test on the suffix was wrong against one of them and would have scored
--     every order under the wrong rule. `order_id` is normalised for the same
--     reason: stripped to the bare store id, which is the key the live sync
--     writes, whether or not the suffix was stored.
--     Rows that can't be represented (no order id, date, or email), and
--     Squarespace's test orders, are counted in `membership_orders_total`
--     but not exported, so the importer can report how many were left
--     behind instead of hiding it. Test orders are dropped here rather than
--     carried and filtered later: nothing downstream has a use for them.
-- Legacy timestamps are naive UTC (`datetime.utcnow()`), so dates are taken
-- as-is without timezone conversion.

SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;

SELECT json_build_object(
    'format_version', 5,
    'exported_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'member_since', COALESCE((
        SELECT json_agg(
            json_build_object('email', t.email, 'member_since', t.member_since)
            ORDER BY t.email
        )
        FROM (
            SELECT lower(u.email) AS email,
                   to_char(min(am.created_on), 'YYYY-MM-DD') AS member_since
            FROM annual_membership am
            JOIN users u ON u.id = am.user_id
            WHERE u.email IS NOT NULL AND am.created_on IS NOT NULL
            GROUP BY lower(u.email)
        ) t
    ), '[]'::json),
    'display_names', COALESCE((
        SELECT json_agg(
            json_build_object('email', t.email, 'display_name', t.display_name)
            ORDER BY t.email
        )
        FROM (
            SELECT lower(u.email) AS email, btrim(u.fullname) AS display_name
            FROM users u
            WHERE u.email IS NOT NULL
              AND NULLIF(btrim(u.fullname), '') IS NOT NULL
              -- Only people who actually bought something. Everyone who ever
              -- signed in has a `users` row, and `ensure_user()` fills
              -- `fullname` from their Google or Apple profile -- a name they
              -- were given by a provider, not one they chose here.
              AND EXISTS (SELECT 1 FROM annual_membership o WHERE o.user_id = u.id)
              -- Only where it differs from the name their latest order would
              -- produce. Elsewhere `fullname` is simply a copy of that, made
              -- by `ensure_user()`, and importing those would pin every
              -- member's name to whatever it happened to be at cutover
              -- instead of letting it keep following the store.
              AND btrim(u.fullname) IS DISTINCT FROM (
                  SELECT btrim(concat_ws(' ',
                             NULLIF(btrim(am.billing_address_first_name), ''),
                             NULLIF(btrim(am.billing_address_last_name), '')))
                  FROM annual_membership am
                  WHERE am.user_id = u.id
                    AND am.created_on IS NOT NULL
                    AND NOT COALESCE(am.test_mode, false)
                  ORDER BY am.created_on DESC
                  LIMIT 1
              )
        ) t
    ), '[]'::json),
    'membership_cards', COALESCE((
        SELECT json_agg(
            json_build_object(
                'serial_number', mc.serial_number::text,
                'email', lower(u.email),
                'full_name', u.fullname,
                'member_since', to_char(mc.member_since, 'YYYY-MM-DD'),
                'member_until', to_char(mc.member_until, 'YYYY-MM-DD')
            )
            ORDER BY mc.serial_number
        )
        FROM membership_cards mc
        JOIN users u ON u.id = mc.user_id
        WHERE u.email IS NOT NULL
    ), '[]'::json),
    'membership_orders_total', (SELECT count(*) FROM annual_membership),
    'membership_orders', COALESCE((
        SELECT json_agg(
            json_build_object(
                -- The key the BigCommerce sync writes for the same order
                -- (`bigCommerceOrderKey()`: the store's own order id), so an
                -- imported order and a synced one are one row rather than
                -- two. The old app stored `{id}_bc`; stripping to the part
                -- before the first underscore gives the bare id whether or
                -- not a given row carries the suffix.
                'order_id', CASE
                    WHEN am.channel_name LIKE 'bigcommerce%'
                        THEN split_part(am.order_id, '_', 1)
                    ELSE am.order_id
                END,
                -- Which era an order belongs to, and so which counting rule
                -- applies. Taken from the channel, which the old system set
                -- to `bigcommerce_{source}` or to `Squarespace`, and never
                -- leaves null. Not from the shape of the order id: a suffix
                -- test that is wrong for this database's actual contents
                -- classifies every order as Squarespace and scores roughly
                -- 1,400 abandoned carts as memberships.
                'source', CASE
                    WHEN am.channel_name LIKE 'bigcommerce%' THEN 'bigcommerce'
                    ELSE 'squarespace'
                END,
                'order_number', am.order_number,
                'channel_name', am.channel_name,
                'order_email', lower(am.customer_email),
                'member_email', lower(COALESCE(u.email, am.customer_email)),
                'first_name', am.billing_address_first_name,
                'last_name', am.billing_address_last_name,
                'customer_id', CASE WHEN am.channel_name LIKE 'bigcommerce%' THEN u.bigcommerce_id END,
                'sku', am.sku,
                'product_name', am.product_name,
                'status', am.fulfillment_status,
                'created_on', to_char(am.created_on, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'modified_on', to_char(am.modified_on, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            )
            ORDER BY am.created_on, am.order_id
        )
        FROM annual_membership am
        LEFT JOIN users u ON u.id = am.user_id
        WHERE am.order_id IS NOT NULL
          AND am.created_on IS NOT NULL
          AND am.customer_email IS NOT NULL
          AND NOT COALESCE(am.test_mode, false)
    ), '[]'::json)
);
