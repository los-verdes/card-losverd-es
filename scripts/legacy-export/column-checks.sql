-- Counts and shapes from the legacy Postgres database, read through
-- BigQuery's federated connection so no local Cloud SQL access is needed.
--
-- Why this exists, and why it does not query the BigQuery view:
--   `lv-digital-membership.membercard.annual_membership` is a *view* over
--   EXTERNAL_QUERY that rewrites `order_id` as `split_part(order_id, '_', 1)`
--   -- it strips whatever suffix the column holds before anyone sees it.
--   `export.sql` decides an order's era and its key from that suffix, so
--   every question about it has to be asked of the column itself. Each
--   statement below wraps a Postgres query in EXTERNAL_QUERY and reads the
--   table directly. Every result is a count or a shape; none returns a
--   member's name, email or id, so the output is safe to paste into an issue.
--
-- Run in the BigQuery console as one script (each statement gets its own
-- result tab), or one statement at a time. `bq query --use_legacy_sql=false
-- < scripts/legacy-export/column-checks.sql` also works.
--
-- Postgres notes: `fulfillment_status` is an enum, hence the casts; `rows`
-- is a reserved word, hence `n`. The connection id is repeated per statement
-- because EXTERNAL_QUERY wants a literal there.

-- 1. Does the `_bc` suffix agree with the channel?  The decisive one.
--    Want exactly two groups: (true, true) and (false, false). Any row in
--    the other two means `right(order_id, 3) = '_bc'` and `channel_name`
--    disagree about an order's era, and the export would misclassify it.
--    All rows in (false, *) means the column holds no suffix and PR #204's
--    key change is right; all BigCommerce rows in (true, true) means it is
--    stored and appending another would produce `1234_bc_bc`.
SELECT * FROM EXTERNAL_QUERY(
  'projects/lv-digital-membership/locations/us-central1/connections/lv-digital-membership',
  """
  SELECT right(order_id, 3) = '_bc'            AS has_bc_suffix,
         channel_name LIKE 'bigcommerce%'      AS looks_bigcommerce,
         count(*)                              AS n
  FROM annual_membership
  GROUP BY 1, 2
  ORDER BY 1, 2
""");

-- 2. What shapes do the ids come in, per channel?  Catches anything neither
--    branch of the export expects. Expected: every BigCommerce channel with
--    one ending and a narrow length range; Squarespace at a constant 24.
SELECT * FROM EXTERNAL_QUERY(
  'projects/lv-digital-membership/locations/us-central1/connections/lv-digital-membership',
  """
  SELECT channel_name,
         right(order_id, 3)                    AS last_three,
         count(*)                              AS n,
         min(length(order_id))                 AS min_len,
         max(length(order_id))                 AS max_len
  FROM annual_membership
  GROUP BY channel_name, last_three
  ORDER BY n DESC
""");

-- 3. Are order ids unique, before and after stripping a suffix?
--    `membership_orders.order_id` is a primary key on our side, so a
--    duplicate means one row silently overwriting another at import.
--    `distinct_bare` < `distinct_ids` would mean the same store order exists
--    both with and without a suffix, which the export must normalise.
--    Also the evidence for #198: the old app keyed on order_id alone, so a
--    two-membership order had already collapsed there if n = distinct_ids.
SELECT * FROM EXTERNAL_QUERY(
  'projects/lv-digital-membership/locations/us-central1/connections/lv-digital-membership',
  """
  SELECT count(*)                                        AS n,
         count(DISTINCT order_id)                        AS distinct_ids,
         count(DISTINCT split_part(order_id, '_', 1))    AS distinct_bare,
         count(DISTINCT (order_id, line_item_id))        AS distinct_order_line
  FROM annual_membership
  WHERE order_id IS NOT NULL
""");

-- 4. How many rows will the export actually emit?  These are export.sql's
--    own filters, so `representable` should equal the length of what it
--    writes and `n` its `membership_orders_total`.
SELECT * FROM EXTERNAL_QUERY(
  'projects/lv-digital-membership/locations/us-central1/connections/lv-digital-membership',
  """
  SELECT count(*)                                                    AS n,
         count(*) FILTER (WHERE order_id IS NOT NULL
                            AND created_on IS NOT NULL
                            AND customer_email IS NOT NULL
                            AND NOT COALESCE(test_mode, false))      AS representable,
         count(*) FILTER (WHERE COALESCE(test_mode, false))          AS test_orders,
         count(*) FILTER (WHERE user_id IS NULL)                     AS unlinked_to_a_user,
         count(*) FILTER (WHERE order_id IS NULL)                    AS no_order_id,
         count(*) FILTER (WHERE created_on IS NULL)                  AS no_created_on,
         count(*) FILTER (WHERE customer_email IS NULL)              AS no_email
  FROM annual_membership
""");

-- 5. Status presence, widened to catch an empty string as well as NULL.
SELECT * FROM EXTERNAL_QUERY(
  'projects/lv-digital-membership/locations/us-central1/connections/lv-digital-membership',
  """
  SELECT count(*) FILTER (WHERE fulfillment_status IS NULL)                              AS null_status,
         count(*) FILTER (WHERE btrim(COALESCE(fulfillment_status::text, '')) = '')      AS null_or_blank,
         count(DISTINCT fulfillment_status)                                              AS distinct_statuses,
         count(*)                                                                        AS n
  FROM annual_membership
""");

-- 6. Which statuses exist, by era, and how many rows carry each.  The one
--    most likely to surprise: both counting rules are lists written against
--    a vocabulary nobody had enumerated. A BigCommerce-side status outside
--    the paid allow-list in `src/lib/membershipOrders.ts` is a member who
--    would quietly lose their card at cutover.
SELECT * FROM EXTERNAL_QUERY(
  'projects/lv-digital-membership/locations/us-central1/connections/lv-digital-membership',
  """
  SELECT channel_name LIKE 'bigcommerce%'                              AS looks_bigcommerce,
         lower(btrim(COALESCE(fulfillment_status::text, '')))          AS status,
         count(*)                                                      AS n
  FROM annual_membership
  GROUP BY 1, 2
  ORDER BY 1, n DESC
""");

-- 7. Which users have a chosen display name that differs from their latest
--    order's billing name -- the count export.sql's `display_names` section
--    will emit. A count only; the names themselves stay in Postgres.
--    (Written with LATERAL rather than a correlated subquery: the federated
--    connection failed to prepare the subquery form.)
SELECT * FROM EXTERNAL_QUERY(
  'projects/lv-digital-membership/locations/us-central1/connections/lv-digital-membership',
  """
  SELECT count(*) AS users_with_chosen_name
  FROM users u
  LEFT JOIN LATERAL (
      SELECT btrim(concat_ws(' ',
                 NULLIF(btrim(am.billing_address_first_name), ''),
                 NULLIF(btrim(am.billing_address_last_name), ''))) AS billing_name
      FROM annual_membership am
      WHERE am.user_id = u.id
        AND am.created_on IS NOT NULL
        AND NOT COALESCE(am.test_mode, false)
      ORDER BY am.created_on DESC
      LIMIT 1
  ) latest ON true
  WHERE u.email IS NOT NULL
    AND NULLIF(btrim(u.fullname), '') IS NOT NULL
    AND EXISTS (SELECT 1 FROM annual_membership o WHERE o.user_id = u.id)
    AND btrim(u.fullname) IS DISTINCT FROM latest.billing_name
  """);
