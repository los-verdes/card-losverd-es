#!/bin/bash
# Outbound firewall for the dev container, run as root on every container
# start (devcontainer.json's postStartCommand).
#
# Traffic is allowed by name, not by address. Every outbound HTTPS
# connection is redirected to a local proxy (egress-proxy.conf), which reads
# the requested name and connects only to names in allowed-domains.txt. The
# only other traffic out is DNS to the container's own resolver; everything
# else is refused. Filtering by address could not do this: CDNs serve
# thousands of sites from the same addresses, so admitting one name's
# address admitted every site sharing it.
#
# Denied connections are logged in /var/log/egress-proxy/access.log.
set -euo pipefail
IFS=$'\n\t'

CONF_DIR=/etc/egress-proxy
PROXY_CONF=$CONF_DIR/egress-proxy.conf
PROXY_USER=www-data
PROXY_PORT=8443

# 1. Build the proxy's configuration and check it, before touching any rule.

# The allowlist, as nginx map entries. Each line must be a hostname, with an
# optional leading dot.
allowed=$(sed -E 's/#.*//; s/[[:space:]]+//g; /^$/d' "$CONF_DIR/allowed-domains.txt" | tr 'A-Z' 'a-z')
if invalid=$(grep -vE '^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' <<<"$allowed"); then
    echo "ERROR: not a hostname in allowed-domains.txt: $invalid" >&2
    exit 1
fi
sed 's/$/ allow;/' <<<"$allowed" >"$CONF_DIR/allowed-domains.map"

# The container's DNS servers, which the proxy uses and which are the only
# DNS servers anything may query.
mapfile -t nameservers < <(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ { print $2 }' /etc/resolv.conf)
if [ "${#nameservers[@]}" -eq 0 ]; then
    echo "ERROR: no IPv4 nameserver in /etc/resolv.conf" >&2
    exit 1
fi
printf 'resolver %s ipv6=off valid=30s;\n' "$(IFS=' '; echo "${nameservers[*]}")" >"$CONF_DIR/resolver.conf"

mkdir -p /var/log/egress-proxy
nginx -t -q -c "$PROXY_CONF"

# 2. Close everything, then open what is allowed. Policies go to DROP first,
# so a failure from here on leaves the container with no way out rather than
# an open one.

# Docker's embedded DNS (127.0.0.11) relies on NAT rules; keep them.
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X

if [ -n "$DOCKER_DNS_RULES" ]; then
    echo "Restoring Docker DNS rules..."
    iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
fi

# No IPv6 at all, other than loopback.
if ip6tables -L -n >/dev/null 2>&1; then
    ip6tables -P INPUT DROP
    ip6tables -P FORWARD DROP
    ip6tables -P OUTPUT DROP
    ip6tables -F
    ip6tables -A INPUT -i lo -j ACCEPT
    ip6tables -A OUTPUT -o lo -j ACCEPT
fi

iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

for ns in "${nameservers[@]}"; do
    iptables -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT
    iptables -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT
done

# The Docker host's network, for VS Code and forwarded ports.
HOST_IP=$(ip route | awk '/^default/ { print $3; exit }')
if [ -z "$HOST_IP" ]; then
    echo "ERROR: Failed to detect host IP" >&2
    exit 1
fi
HOST_NETWORK=$(echo "$HOST_IP" | sed "s/\.[0-9]*$/.0\/24/")
echo "Host network detected as: $HOST_NETWORK"
iptables -A INPUT -s "$HOST_NETWORK" -j ACCEPT
iptables -A OUTPUT -d "$HOST_NETWORK" -j ACCEPT

# Every other process's HTTPS goes to the proxy; the proxy alone goes out.
iptables -t nat -A OUTPUT -d 127.0.0.0/8 -j RETURN
iptables -t nat -A OUTPUT -d "$HOST_NETWORK" -j RETURN
iptables -t nat -A OUTPUT -p tcp --dport 443 -m owner ! --uid-owner "$PROXY_USER" -j REDIRECT --to-ports "$PROXY_PORT"
iptables -A OUTPUT -p tcp --dport 443 -m owner --uid-owner "$PROXY_USER" -j ACCEPT

# Refuse the rest at once, rather than letting it time out.
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

# 3. Start the proxy, or have a running one pick up the new configuration.
if pgrep -x nginx >/dev/null; then
    nginx -c "$PROXY_CONF" -s reload
else
    nginx -c "$PROXY_CONF"
fi

echo "Firewall configuration complete"
echo "Verifying firewall rules..."
if curl --connect-timeout 5 https://example.com >/dev/null 2>&1; then
    echo "ERROR: Firewall verification failed - was able to reach https://example.com"
    exit 1
else
    echo "Firewall verification passed - unable to reach https://example.com as expected"
fi

if ! curl --connect-timeout 5 https://api.github.com/zen >/dev/null 2>&1; then
    echo "ERROR: Firewall verification failed - unable to reach https://api.github.com"
    exit 1
else
    echo "Firewall verification passed - able to reach https://api.github.com as expected"
fi
