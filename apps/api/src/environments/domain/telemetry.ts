/**
 * The resource attribute every environment's metrics and traces carry, with the
 * environment's ID, so the platform knows which environment sent them. Monitoring reads
 * them by it.
 */
export const ENVIRONMENT_ATTRIBUTE = 'dreamdevops.environment.id';

/** How often applications send their metrics, unless the environment's own variables say otherwise. */
export const METRIC_EXPORT_INTERVAL_MS = 15_000;

/** Where an environment's containers send what they measure. */
export interface TelemetryTargets {
  readonly environmentId: string;
  /** The application's short name, which names the service its traces come from. */
  readonly serviceName: string;
  /** Where metrics go, over OTLP, or null to send none. */
  readonly metricsEndpoint: string | null;
  /** Where traces go, over OTLP, or null to send none. */
  readonly tracesEndpoint: string | null;
}

/**
 * The environment's variables, with what a container needs to send its metrics and traces
 * to the platform. They're the standard OpenTelemetry settings, so any application that
 * uses OpenTelemetry sends them without changes.
 *
 * The environment's own variables can send them elsewhere, at another interval, or under
 * another service name. The environment's attribute is always added to any attributes of
 * their own, last, so it's the one that counts.
 */
export function withTelemetry(values: Readonly<Record<string, string>>, targets: TelemetryTargets): Record<string, string> {
  const { metricsEndpoint, tracesEndpoint } = targets;
  if (metricsEndpoint === null && tracesEndpoint === null) {
    return { ...values };
  }
  const attribute = `${ENVIRONMENT_ATTRIBUTE}=${targets.environmentId}`;
  const own = values['OTEL_RESOURCE_ATTRIBUTES']?.trim() ?? '';
  return {
    OTEL_SERVICE_NAME: targets.serviceName,
    ...(metricsEndpoint === null
      ? {}
      : { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: metricsEndpoint, OTEL_METRIC_EXPORT_INTERVAL: String(METRIC_EXPORT_INTERVAL_MS) }),
    ...(tracesEndpoint === null ? {} : { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: tracesEndpoint }),
    ...values,
    OTEL_RESOURCE_ATTRIBUTES: own === '' ? attribute : `${own},${attribute}`,
  };
}
