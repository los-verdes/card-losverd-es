# Turning on the store connection and card themes

Three member-facing features are built, tested on staging, and switched off in production. This is the plan for turning
each on: what changes for members, what has to be true first, the steps, how to check, and how to turn it back off. The
rules themselves are in the [provenance document](membership-card-provenance.md); this covers only the switching.

| Feature                                                                           | Switch                                                     | Production now      | Staging now                      | Members affected           |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------- | -------------------------------- | -------------------------- |
| Theme choice, and Apple's poster layout                                           | `CARD_THEME_CHOICE`, `APPLE_POSTER_PASSES`                 | `"admins"`, `"off"` | `"admins"`, `"on"`               | Only those who choose      |
| Year themes by default                                                            | `CARD_THEME_YEAR_DEFAULTS`                                 | `"false"`           | `"false"`                        | Everyone who hasn't chosen |
| Store connection ([#38](https://github.com/los-verdes/card-losverd-es/issues/38)) | `BIGCOMMERCE_APP_CLIENT_SECRET`, and the storefront script | Unset, no script    | Set, script on the sandbox store | Those who connect          |

The switches in `wrangler.toml` deploy like any other change: a pull request, then CI. Staging goes first for each.

## Order

1. **Theme choice and posters together.** Opt-in: nothing changes for anyone who doesn't choose.
2. **Store connection.** Also opt-in, and independent of themes; it can go the same day.
3. **Year themes by default, last, or not at all.** It is the one step that changes cards nobody asked to change, so it
   waits until the first two have settled, and goes ahead only if the Merch Team want it.

The [announcement](#announcement) goes out once 1 and 2 are on.

## 1. Theme choice and Apple's poster layout

**What members see:** "Change how my card looks" on their card page, leading to every theme they may use, each previewed
as their own card. Which themes those are is in the provenance document's "Card Themes". Choosing one redraws the card
image and updates installed passes; on iOS 27 a themed Apple pass takes the poster layout, with the theme's art behind
it. Classic has no poster art and looks as it does today.

**First:**

- Admins have tried it on real cards (the switch has been `"admins"` since #333), including a pass on iOS 27 and one on
  Android.
- #446 is merged, so trying several themes doesn't redraw every preview on each save.
- The Slack app is in each subgroup's channel (`#los-pringles`, `#verdirojas`), or that subgroup's members won't be
  offered its theme. The Slack sync logs a channel it can't read.

**Steps:**

1. Staging: `CARD_THEME_CHOICE = "everyone"`. Sign in as a member who isn't an admin, choose a theme, and check the
   card, the Apple pass and the Google pass.
2. Production: `CARD_THEME_CHOICE = "everyone"` and `APPLE_POSTER_PASSES = "on"` in one pull request. No bulk pass
   refresh: each pass updates when its member chooses.

**Check:** a member who isn't an admin sees the link and can choose. `card_theme.saved` outcomes appear in Workers Logs,
and the readiness page stays clear.

**Turning it off:** `CARD_THEME_CHOICE = "admins"`. Choices already made stay drawn (the switch governs choosing, not
drawing). Posters off: `APPLE_POSTER_PASSES = "off"`, then `refresh-passes-admins` and `refresh-passes` (below) so
installed passes drop the layout.

## 2. Store connection

**What members see:** on the card site, "Connect your store account" on their card page. Once connected, a "Membership
card" link in the Los Verdes store's header and account menu signs them straight in to the card site, and their store
account pages show the card, its status, both wallet buttons and links to change the name or theme. Members who check
out as guests (about 5% of orders) have no store account to connect.

**First:**

- The Merch Team know it's coming, since members will ask them about it, and agree the day.
- The storefront script and the production secret go in **together**. The production app id is already set, so the
  secret alone shows every member a "Connect" button that does nothing until the script is on the store.

**Steps:**

1. Add the storefront script in the store's Script Manager (under Channel Manager on a multi-storefront store): Footer,
   All pages, Essential, `https://card.losverd.es/store/storefront.js`. The README's "Adding the storefront script" has
   the detail. It does nothing until step 2.
2. `just secrets-push production BIGCOMMERCE_APP_CLIENT_SECRET`.

No app install, webhook or migration is needed; the app's client id and secret are all the card site uses.

**Check:** connect a real store account from the card page, follow "Membership card" from the store, and see the card on
the store's account page. Connections appear in the audit log as `store_account.linked`.

**Turning it off:** remove the script tag, then delete the production secret
(`npx wrangler secret delete BIGCOMMERCE_APP_CLIENT_SECRET --env production`). Connections already made are kept, and
work again if it's turned back on.

**Afterwards:** check whether the store's legacy app is still installed, and uninstall it once nothing uses it (#38).

## 3. Year themes by default

**What members see:** every card whose holder hasn't chosen a theme is drawn in the theme of their "member since" year,
or classic if that year has none. That covers the card image, the Apple pass and the Google pass, including passes
already on phones.

**First:**

- The Merch Team agree; this is the step members may ask about without having done anything.
- Steps 1 and 2 have settled.

**Steps:**

1. Staging: `CARD_THEME_YEAR_DEFAULTS = "true"`, then check a member's card who hasn't chosen.
2. Production: `CARD_THEME_YEAR_DEFAULTS = "true"`. The card site changes at once; installed passes don't until told.
3. `just etl-run production refresh-passes-admins --yes-production`, then check admins' own passes on a phone.
4. `just etl-run production refresh-passes --yes-production`, for every other installed pass.

Neither refresh emails anyone: they mark each member's record and tell their passes, in batches of 50, and running one
twice changes nothing.

**Check:** a member who hasn't chosen sees their year's theme on the card page and, after the refresh, on their pass.

**Turning it off:** `CARD_THEME_YEAR_DEFAULTS = "false"`, then both refreshes again.

## Announcement

For the Los Verdes Slack, once steps 1 and 2 are on, covering what's new and where to ask. If step 3 follows, a short
second note says that unchosen cards now show the member's "member since" year.

## Not part of this

- Shopping and renewing from the card site through the store's Customer Login (#38, phase 3).
- The theme authoring guide (#333, piece 8), and a theme for the fundraising scarf until its licence is checked.
- Showing admins who is in each subgroup (#447).
