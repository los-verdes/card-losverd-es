-- One-time, read-only export from the legacy digital-membership Postgres
-- database. Emits a single JSON document; see ./README.md for how to run
-- it and load the result into D1.
--
-- Column semantics mirror the legacy SQLAlchemy models exactly:
--   * member_since: `User.member_since` = MIN(annual_membership.created_on),
--     with no channel/test-mode filtering (that's what cards show today).
--   * membership_cards: every card ever minted (one per membership period),
--     since any of them may still be out in the world as a QR code.
-- Legacy timestamps are naive UTC (`datetime.utcnow()`), so dates are taken
-- as-is without timezone conversion.

SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;

SELECT json_build_object(
    'format_version', 1,
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
    ), '[]'::json)
);
