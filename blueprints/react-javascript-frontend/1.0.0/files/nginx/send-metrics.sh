#!/bin/sh
# Sends the container's CPU and memory use over OTLP every 15 seconds, so the platform
# can show them. It sends nothing unless told where, with the standard
# OTEL_EXPORTER_OTLP_METRICS_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT, which the platform sets.
#
# nginx runs it as it starts, from /docker-entrypoint.d/, and it keeps sending in the
# background. "send-metrics.sh once" sends one report and says whether it worked.
set -u
set -f

endpoint="${OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:-}"
if [ -z "$endpoint" ] && [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
  endpoint="${OTEL_EXPORTER_OTLP_ENDPOINT%/}/v1/metrics"
fi
if [ -z "$endpoint" ]; then
  exit 0
fi

interval_ms="${OTEL_METRIC_EXPORT_INTERVAL:-15000}"
case "$interval_ms" in
  '' | *[!0-9]*) interval_ms=15000 ;;
esac
interval=$((interval_ms / 1000))
if [ "$interval" -lt 1 ]; then
  interval=1
fi

# The container's own cgroup. Tests point it at files of their own.
cgroup="${METRICS_CGROUP_ROOT:-/sys/fs/cgroup}"
started="$(date +%s)000000000"

# CPU time the container has used, in seconds, from cgroup v2 or v1.
cpu_seconds() {
  if [ -r "$cgroup/cpu.stat" ]; then
    awk '$1 == "usage_usec" { printf "%.6f", $2 / 1000000; found = 1 } END { exit !found }' "$cgroup/cpu.stat"
  else
    awk '{ printf "%.6f", $1 / 1000000000 }' "$cgroup/cpuacct/cpuacct.usage"
  fi
}

# Memory the container holds, in bytes, without the file cache it can give back, as docker stats counts it.
memory_bytes() {
  if [ -r "$cgroup/memory.current" ]; then
    usage="$(cat "$cgroup/memory.current")" && stat="$cgroup/memory.stat" && key=inactive_file
  else
    usage="$(cat "$cgroup/memory/memory.usage_in_bytes")" && stat="$cgroup/memory/memory.stat" && key=total_inactive_file
  fi || return 1
  awk -v usage="$usage" -v key="$key" '$1 == key { cache = $2 } END { printf "%.0f", (usage > cache ? usage - cache : usage) }' "$stat"
}

# One report, in OTLP's JSON form. Attributes are the service's name and instance, then
# each of OTEL_RESOURCE_ATTRIBUTES, the last value of a key winning. Only plain values
# pass, so nothing can break the JSON.
report() {
  cpu="$(cpu_seconds 2>/dev/null)" && memory="$(memory_bytes 2>/dev/null)" || return 1
  body="$(awk \
    -v service="${OTEL_SERVICE_NAME:-__APP_SLUG__}" \
    -v instance="${HOSTNAME:-unknown}" \
    -v attributes="${OTEL_RESOURCE_ATTRIBUTES:-}" \
    -v start="$started" \
    -v now="$(date +%s)000000000" \
    -v cpu="$cpu" \
    -v memory="$memory" '
    function add(key, value) {
      if (key !~ "^[A-Za-z0-9._-]+$" || value !~ "^[A-Za-z0-9._:/-]*$") return
      if (!(key in values)) order[++count] = key
      values[key] = value
    }
    BEGIN {
      add("service.name", service)
      add("service.instance.id", instance)
      pairs = split(attributes, list, ",")
      for (i = 1; i <= pairs; i++) {
        split_at = index(list[i], "=")
        if (split_at == 0) continue
        key = substr(list[i], 1, split_at - 1); value = substr(list[i], split_at + 1)
        gsub(/^ +| +$/, "", key); gsub(/^ +| +$/, "", value)
        add(key, value)
      }
      resource = ""
      for (i = 1; i <= count; i++) {
        resource = resource (i > 1 ? "," : "") "{\"key\":\"" order[i] "\",\"value\":{\"stringValue\":\"" values[order[i]] "\"}}"
      }
      printf "{\"resourceMetrics\":[{\"resource\":{\"attributes\":[%s]},\"scopeMetrics\":[{\"scope\":{\"name\":\"send-metrics.sh\"},\"metrics\":[", resource
      printf "{\"name\":\"process.cpu.time\",\"unit\":\"s\",\"description\":\"CPU time the container has used.\","
      printf "\"sum\":{\"aggregationTemporality\":2,\"isMonotonic\":true,\"dataPoints\":[{\"startTimeUnixNano\":\"%s\",\"timeUnixNano\":\"%s\",\"asDouble\":%s}]}},", start, now, cpu
      printf "{\"name\":\"process.memory.usage\",\"unit\":\"By\",\"description\":\"Memory the container holds in RAM.\","
      printf "\"sum\":{\"aggregationTemporality\":2,\"isMonotonic\":false,\"dataPoints\":[{\"startTimeUnixNano\":\"%s\",\"timeUnixNano\":\"%s\",\"asInt\":\"%s\"}]}}", start, now, memory
      printf "]}]}]}"
    }')" || return 1
  wget -q -O /dev/null -T 5 --header 'Content-Type: application/json' --post-data "$body" "$endpoint" 2>/dev/null
}

if [ "${1:-}" = once ]; then
  report
  exit
fi

(
  warned=''
  while :; do
    if report; then
      warned=''
    elif [ -z "$warned" ]; then
      echo "send-metrics.sh: couldn't send metrics to $endpoint. It keeps trying every ${interval}s." >&2
      warned=yes
    fi
    sleep "$interval"
  done
) </dev/null &
