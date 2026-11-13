"""Sends metrics and traces over OTLP, only when told where, with the standard OTEL_* variables.

The platform sets the ones for metrics and traces, so it can show them on its dashboard.
"""

import os
import sys
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass

# The web framework's instrumentation sends http.server.request.duration, in seconds, the name
# the platform reads, only when asked for the stable names. It reads this once, as it starts.
os.environ.setdefault("OTEL_SEMCONV_STABILITY_OPT_IN", "http")

from opentelemetry import metrics, trace  # noqa: E402 - after the setting above, which the SDK reads.
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter  # noqa: E402
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter  # noqa: E402
from opentelemetry.metrics import CallbackOptions, Meter, Observation  # noqa: E402
from opentelemetry.sdk.metrics import MeterProvider  # noqa: E402
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader  # noqa: E402
from opentelemetry.sdk.resources import Resource  # noqa: E402
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import BatchSpanProcessor  # noqa: E402

SERVICE_NAME = "__APP_SLUG__"
"""The name traces and metrics come under, unless OTEL_SERVICE_NAME says another."""

HEALTH_CHECKS = "health/live,health/ready"
"""The paths the web framework's instrumentation leaves out, as they aren't traffic."""

_DEFAULT_EXPORT_INTERVAL_MS = 15_000


@dataclass(frozen=True)
class TelemetrySettings:
    """What the service sends."""

    metrics: bool
    """Whether to send metrics. The platform asks for them, to show them on its dashboard."""
    traces: bool
    """Whether to send traces."""
    export_interval_ms: int


def telemetry_settings(env: Mapping[str, str]) -> TelemetrySettings:
    """Sends only what it's told where to send, so it sends nothing by default."""
    interval = env.get("OTEL_METRIC_EXPORT_INTERVAL", "")
    return TelemetrySettings(
        metrics=bool(env.get("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT") or env.get("OTEL_EXPORTER_OTLP_ENDPOINT")),
        traces=bool(env.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or env.get("OTEL_EXPORTER_OTLP_ENDPOINT")),
        export_interval_ms=int(interval) if interval.isdigit() and int(interval) > 0 else _DEFAULT_EXPORT_INTERVAL_MS,
    )


@dataclass(frozen=True)
class ProcessUsage:
    """How much CPU and memory the process uses."""

    cpu: Callable[[], tuple[float, float]]
    """CPU time used so far, in seconds, in user and system mode."""
    memory: Callable[[], int]
    """Memory held in RAM, in bytes."""


def _resident_memory() -> int:
    # The container's processes run on Linux, which says what's in RAM now. Elsewhere, such
    # as while developing on a Mac, the most it has held is the best there is, and on
    # Windows, which has neither, nothing is reported.
    try:
        with open("/proc/self/statm") as statm:
            return int(statm.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    except OSError:
        try:
            import resource  # noqa: PLC0415 - Unix only.
        except ImportError:
            return 0
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return peak if sys.platform == "darwin" else peak * 1024


THIS_PROCESS = ProcessUsage(cpu=lambda: (os.times().user, os.times().system), memory=_resident_memory)


def observe_process(meter: Meter, usage: ProcessUsage = THIS_PROCESS) -> None:
    """Reports the CPU time and memory the service uses, with their standard OpenTelemetry names,
    so any tool that reads OpenTelemetry metrics, such as the platform, shows them."""

    def cpu(_options: CallbackOptions) -> Iterable[Observation]:
        user, system = usage.cpu()
        return [Observation(user, {"cpu.mode": "user"}), Observation(system, {"cpu.mode": "system"})]

    def memory(_options: CallbackOptions) -> Iterable[Observation]:
        return [Observation(usage.memory())]

    meter.create_observable_counter("process.cpu.time", [cpu], unit="s", description="CPU time the process has used.")
    meter.create_observable_up_down_counter(
        "process.memory.usage", [memory], unit="By", description="Memory the process holds in RAM."
    )


def start_telemetry(env: Mapping[str, str] = os.environ) -> Callable[[], None]:
    """Starts sending what's asked for, and gives what sends anything still waiting, before the
    process stops. Start it before the web framework is instrumented, which uses what it sets up."""
    settings = telemetry_settings(env)
    # The platform adds the environment's ID to OTEL_RESOURCE_ATTRIBUTES, which Resource reads.
    service = Resource.create({"service.name": env.get("OTEL_SERVICE_NAME") or SERVICE_NAME})
    shutdowns: list[Callable[[], object]] = []
    if settings.traces:
        tracer_provider = TracerProvider(resource=service)
        tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
        trace.set_tracer_provider(tracer_provider)
        shutdowns.append(tracer_provider.shutdown)
    if settings.metrics:
        reader = PeriodicExportingMetricReader(OTLPMetricExporter(), export_interval_millis=settings.export_interval_ms)
        meter_provider = MeterProvider(resource=service, metric_readers=[reader])
        metrics.set_meter_provider(meter_provider)
        observe_process(meter_provider.get_meter(SERVICE_NAME))
        shutdowns.append(meter_provider.shutdown)

    def shutdown() -> None:
        for stop in shutdowns:
            stop()

    return shutdown
