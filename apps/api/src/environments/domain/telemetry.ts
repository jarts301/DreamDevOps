/**
 * The resource attribute every environment's metrics carry, with the environment's ID,
 * so the platform knows which environment sent them. Monitoring reads metrics by it.
 */
export const ENVIRONMENT_ATTRIBUTE = 'dreamdevops.environment.id';

/** How often applications send their metrics, unless the environment's own variables say otherwise. */
export const METRIC_EXPORT_INTERVAL_MS = 15_000;

/**
 * The environment's variables, with what a container needs to send its metrics to the
 * platform. They're the standard OpenTelemetry settings, so any application that uses
 * OpenTelemetry sends its metrics without changes.
 *
 * The environment's own variables can send them elsewhere, or at another interval. The
 * environment's attribute is always added to any attributes of their own, last, so it's
 * the one that counts.
 */
export function withTelemetry(
  values: Readonly<Record<string, string>>,
  environmentId: string,
  endpoint: string | null,
): Record<string, string> {
  if (endpoint === null) {
    return { ...values };
  }
  const attribute = `${ENVIRONMENT_ATTRIBUTE}=${environmentId}`;
  const own = values['OTEL_RESOURCE_ATTRIBUTES']?.trim() ?? '';
  return {
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint,
    OTEL_METRIC_EXPORT_INTERVAL: String(METRIC_EXPORT_INTERVAL_MS),
    ...values,
    OTEL_RESOURCE_ATTRIBUTES: own === '' ? attribute : `${own},${attribute}`,
  };
}
