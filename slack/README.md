# Slack app

`app-manifest.yaml` is what the `verde-bot` Slack app should be, written so a
second one can be created without reverse-engineering the first. Paste it into
**Create an app → From a manifest** at <https://api.slack.com/apps>, or read it
against an existing app to check the two still agree.

It is kept here for the same reason `terraform/` is: this service depends on
configuration that lives in someone else's console, and configuration that
exists only in a console is configuration nobody can review.

## What the Worker actually does with Slack

Two outbound calls, and nothing else:

- **`users.list`** (`src/slack/membersEtl.ts`) — copies the workspace's user
  list into D1 so members can be cross-referenced against Slack accounts by
  email. Needs `users:read`, and `users:read.email` for the addresses.
- **An incoming webhook** (`src/slack/alert.ts`) — where dead-letter and
  weekly readiness alerts are posted. Created by the `incoming-webhook` scope
  at install time.

**Nothing inbound.** There is no request URL, no event subscription and no
socket mode. Slack never calls this service.

## What was dropped from the legacy app's configuration

The legacy app's manifest declared a `/lv` slash command pointing at a tunnel
hostname. It is deliberately absent here, along with the `commands` scope it
needed.

This matters more than it looks: nothing in this service handles an inbound
Slack request, so an app declaring that command would put `/lv` in the
workspace's command list and fail for everyone who tried it. A manifest is a
promise about what an app can do, and that one would be a promise nobody
kept. `always_online` is `false` for the same reason.

## Installing, and what comes out

Installing produces two credentials, which are separate on purpose and are
stored as separate Worker secrets:

| Produced at install | Worker secret | Used by |
| :--- | :--- | :--- |
| Bot user OAuth token (`xoxb-…`) | `SLACK_BOT_TOKEN` | the members ETL |
| Incoming webhook URL | `SLACK_ALERT_WEBHOOK_URL` | alerts |

Both go into the environment's 1Password item and reach the Worker through
`just secrets-push <env>`. Neither is ever read back from Cloudflare — see the
README's secrets section for why 1Password is the source of truth.

## Two environments

Each environment needs **its own app**, and staging's must not be
production's: a staging ETL holding production's bot token would read the real
membership roll into a database meant for test data. Staging has had its own
since September 2026, which is what let its members sync be put on a schedule
([#133](https://github.com/los-verdes/card-losverd-es/issues/133)).

Change `display_information.name` and `features.bot_user.display_name` so the
two are distinguishable in a channel list. Everything else is identical.
Alerts already announce which environment they came from — `postSlackAlert`
prefixes every message — so the app name is about recognising it in Slack's
own interfaces rather than about reading the alerts.
