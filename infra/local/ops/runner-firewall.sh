#!/bin/sh
# Limits what CI jobs can reach. Jobs run on this engine's network, so these rules apply
# to every job: Forgejo on the CI network, the API on your machine on its own port, and
# the internet. Everything else private, such as PostgreSQL, Keycloak and the other
# ports your machine publishes, is refused. Safe to run repeatedly.
set -eu

: "${CI_SUBNET:?}" "${API_PORT:?}"

for table in iptables ip6tables; do
  $table -N CI-EGRESS 2>/dev/null || $table -F CI-EGRESS
  $table -C OUTPUT -j CI-EGRESS 2>/dev/null || $table -I OUTPUT 1 -j CI-EGRESS
  $table -A CI-EGRESS -o lo -j RETURN
  $table -A CI-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
done

# Forgejo is the only service on the CI network that listens, on port 3000.
iptables -A CI-EGRESS -d "$CI_SUBNET" -p tcp --dport 3000 -j RETURN
iptables -A CI-EGRESS -d "$CI_SUBNET" -p udp --dport 53 -j RETURN

# The API, on the host, and nothing else there.
for address in $(getent ahosts host.docker.internal | awk '{ print $1 }' | sort -u); do
  case "$address" in
    *:*) ip6tables -A CI-EGRESS -d "$address" -p tcp --dport "$API_PORT" -j RETURN ;;
    *) iptables -A CI-EGRESS -d "$address" -p tcp --dport "$API_PORT" -j RETURN ;;
  esac
done

for range in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
  iptables -A CI-EGRESS -d "$range" -j REJECT
done
for range in fc00::/7 fe80::/10; do
  ip6tables -A CI-EGRESS -d "$range" -j REJECT
done

echo "CI jobs can reach Forgejo, the API on port $API_PORT, and the internet."
