#!/bin/bash
# Checks the dev container's outbound firewall from inside the container, as
# an ordinary user. CI runs it after init-firewall.sh
# (.github/workflows/devcontainer.yml); inside the dev container, run
# `test-firewall.sh`.
set -uo pipefail

failed=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; failed=1; }
# Succeeds when an HTTP exchange completes, whatever its status code.
fetch() { curl -s -o /dev/null --connect-timeout 5 --max-time 15 "$@"; }
first_ipv4() { getent ahostsv4 "$1" | awk 'NR == 1 { print $1 }'; }

# Allowed, including a name matched by a leading-dot entry.
for url in https://api.github.com/zen https://registry.npmjs.org/ https://api.anthropic.com/ https://card.losverd.es/; do
    fetch "$url" && pass "allowed: $url" || fail "allowed, but unreachable: $url"
done

# A name that is not on the list.
fetch https://example.com/ && fail "reached example.com" || pass "refused: example.com"

# An unlisted name at a listed name's address. Filtering by address let this
# through, because both sites are served from the same CDN addresses.
card_ip=$(first_ipv4 card.losverd.es)
fetch --resolve "discord.com:443:$card_ip" https://discord.com/ \
    && fail "reached discord.com through card.losverd.es's address ($card_ip)" \
    || pass "refused: discord.com through card.losverd.es's address"

# A listed name at an address of the client's choosing. The proxy connects to
# the name's own address instead, so this reaches GitHub, not 192.0.2.1 (a
# documentation-only address that answers nothing).
body=$(curl -s --connect-timeout 5 --max-time 15 --resolve api.github.com:443:192.0.2.1 https://api.github.com/zen)
[ -n "$body" ] \
    && pass "a listed name is connected to by name, not by the address dialled" \
    || fail "api.github.com pinned to 192.0.2.1 did not reach GitHub"

# HTTPS without a name, straight to an address.
fetch -k "https://$(first_ipv4 api.github.com)/" && fail "reached an address with no name" || pass "refused: HTTPS to a bare address"

# Anything but HTTPS.
fetch http://example.com/ && fail "reached plain HTTP" || pass "refused: plain HTTP"
timeout 5 bash -c 'echo > /dev/tcp/1.1.1.1/22' 2>/dev/null && fail "reached port 22" || pass "refused: SSH"

# DNS only through the container's own resolver.
[ -n "$(dig +short +time=3 +tries=1 api.github.com)" ] && pass "DNS through the container's resolver" || fail "DNS through the container's resolver"
dig +time=2 +tries=1 @1.1.1.1 example.com >/dev/null 2>&1 && fail "DNS reached 1.1.1.1 directly" || pass "refused: DNS to another server"

# Refusals are logged.
grep -q ' deny example\.com ' /var/log/egress-proxy/access.log \
    && pass "refusals are logged" \
    || fail "no 'deny example.com' line in /var/log/egress-proxy/access.log"

exit "$failed"
