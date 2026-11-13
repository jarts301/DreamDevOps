from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader, NumberDataPoint

from service.telemetry import ProcessUsage, TelemetrySettings, observe_process, telemetry_settings


def test_sends_nothing_unless_told_where() -> None:
    assert telemetry_settings({}) == TelemetrySettings(metrics=False, traces=False, export_interval_ms=15_000)


def test_sends_only_metrics_when_only_their_address_is_set_as_the_platform_does() -> None:
    settings = telemetry_settings(
        {
            "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "http://metrics.example.com/v1/metrics",
            "OTEL_METRIC_EXPORT_INTERVAL": "60000",
        }
    )

    assert settings == TelemetrySettings(metrics=True, traces=False, export_interval_ms=60_000)


def test_sends_metrics_and_traces_to_one_address_for_both() -> None:
    settings = telemetry_settings({"OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector.example.com:4318"})

    assert (settings.metrics, settings.traces) == (True, True)


def test_keeps_the_usual_interval_when_the_one_given_is_not_valid() -> None:
    assert telemetry_settings({"OTEL_METRIC_EXPORT_INTERVAL": "often"}).export_interval_ms == 15_000


def test_reports_cpu_time_in_seconds_and_memory_in_bytes_by_their_standard_names() -> None:
    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader])
    observe_process(provider.get_meter("test"), ProcessUsage(cpu=lambda: (1.5, 0.25), memory=lambda: 52_428_800))

    data = reader.get_metrics_data()
    assert data is not None
    collected = {
        metric.name: metric
        for resource in data.resource_metrics
        for scope in resource.scope_metrics
        for metric in scope.metrics
    }

    def points(name: str) -> list[NumberDataPoint]:
        found = collected[name].data.data_points
        assert all(isinstance(point, NumberDataPoint) for point in found)
        return [point for point in found if isinstance(point, NumberDataPoint)]

    assert collected["process.cpu.time"].unit == "s"
    assert [(dict(point.attributes or {})["cpu.mode"], point.value) for point in points("process.cpu.time")] == [
        ("user", 1.5),
        ("system", 0.25),
    ]
    assert collected["process.memory.usage"].unit == "By"
    assert [point.value for point in points("process.memory.usage")] == [52_428_800]
    provider.shutdown()
