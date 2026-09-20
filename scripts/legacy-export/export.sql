-- One-time, read-only export from the legacy digital-membership Postgres
-- database. Emits a single JSON document; see ./README.md for how to run
-- it and load the result into D1.
--
-- Column semantics mirror the legacy SQLAlchemy models exactly:
--   * member_since: `User.member_since` = MIN(annual_membership.created_on),
--     over every order including test ones, because that is the date cards
--     show today. It can therefore predate the earliest exported order.
--   * membership_cards: every card ever minted (one per membership period),
--     since any of them may still be out in the world as a QR code.
--   * membership_orders: every `annual_membership` row (BigCommerce *and*
--     Squarespace), for D1's `membership_orders` history table. This is the
--     only surviving record of Squarespace-era orders. `member_email` is the
--     linked user's current email, which can differ from the order's own.
--     Rows that can't be represented (no order id, date, or email), and
--     Squarespace's test orders, are counted in `membership_orders_total`
--     but not exported, so the importer can report how many were left
--     behind instead of hiding it. Test orders are dropped here rather than
--     carried and filtered later: nothing downstream has a use for them.
-- Legacy timestamps are naive UTC (`datetime.utcnow()`), so dates are taken
-- as-is without timezone conversion.

SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;

SELECT json_build_object(
    'format_version', 3,
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
                'order_id', am.order_id,
                'source', CASE WHEN right(am.order_id, 3) = '_bc' THEN 'bigcommerce' ELSE 'squarespace' END,
                'order_number', am.order_number,
                'channel_name', am.channel_name,
                'order_email', lower(am.customer_email),
                'member_email', lower(COALESCE(u.email, am.customer_email)),
                'first_name', am.billing_address_first_name,
                'last_name', am.billing_address_last_name,
                'customer_id', CASE WHEN right(am.order_id, 3) = '_bc' THEN u.bigcommerce_id END,
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
