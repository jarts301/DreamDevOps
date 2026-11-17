import { createHash } from 'node:crypto';

/**
 * The resource attributes every application's metrics, traces and logs carry, so the
 * platform knows where they come from. Monitoring reads them by these.
 *
 * - The environment and application, by their IDs.
 * - The place: one application in one environment, with one ID made from both, so a
 *   store can be asked about it with a single label.
 * - The company, which only the telemetry gateway adds, for whoever runs the stores.
 */
export const ENVIRONMENT_ATTRIBUTE = 'dreamdevops.environment.id';
export const APPLICATION_ATTRIBUTE = 'dreamdevops.application.id';
export const PLACE_ATTRIBUTE = 'dreamdevops.place.id';
export const COMPANY_ATTRIBUTE = 'dreamdevops.company.id';
/** Attributes only the platform sets. Whatever an application sends under these names is replaced. */
export const PLATFORM_ATTRIBUTE_PREFIX = 'dreamdevops.';

/** How often applications send their metrics, unless the environment's own variables say otherwise. */
export const METRIC_EXPORT_INTERVAL_MS = 15_000;

/**
 * The place an application runs in an environment, as one ID made from both: the same
 * every time, and a UUID, so it can go into queries safely.
 */
export function placeId(environmentId: string, applicationId: string): string {
  const hex = createHash('sha256').update(`dreamdevops-place\n${environmentId.toLowerCase()}\n${applicationId.toLowerCase()}`).digest('hex');
  // Shaped as a version 8 UUID: made by the platform's own rule.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The attributes that say where telemetry comes from, as OTLP resource attributes. */
export function placeAttributes(environmentId: string, applicationId: string): Record<string, string> {
  return {
    [ENVIRONMENT_ATTRIBUTE]: environmentId,
    [APPLICATION_ATTRIBUTE]: applicationId,
    [PLACE_ATTRIBUTE]: placeId(environmentId, applicationId),
  };
}

/** Where an application sends what it measures. */
export interface TelemetryTargets {
  readonly environmentId: string;
  readonly applicationId: string;
  /** The application's short name, which names the service its traces come from. */
  readonly serviceName: string;
  /** Where metrics go, over OTLP, or null to send none. */
  readonly metricsEndpoint: string | null;
  /** Where traces go, over OTLP, or null to send none. */
  readonly tracesEndpoint: string | null;
}

/**
 * The environment's variables, with what an application needs to send its metrics and
 * traces to the platform. They're the standard OpenTelemetry settings, so any application
 * that uses OpenTelemetry sends them without changes.
 *
 * The environment's own variables can send them elsewhere, at another interval, or under
 * another service name. The platform's attributes are always added to any of their own,
 * last, so they're the ones that count. In a cluster, the telemetry gateway sets them
 * again from what it knows, whatever the application sent.
 */
export function withTelemetry(values: Readonly<Record<string, string>>, targets: TelemetryTargets): Record<string, string> {
  const { metricsEndpoint, tracesEndpoint } = targets;
  if (metricsEndpoint === null && tracesEndpoint === null) {
    return { ...values };
  }
  const attributes = Object.entries(placeAttributes(targets.environmentId, targets.applicationId))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  const own = values['OTEL_RESOURCE_ATTRIBUTES']?.trim() ?? '';
  return {
    OTEL_SERVICE_NAME: targets.serviceName,
    ...(metricsEndpoint === null
      ? {}
      : { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: metricsEndpoint, OTEL_METRIC_EXPORT_INTERVAL: String(METRIC_EXPORT_INTERVAL_MS) }),
    ...(tracesEndpoint === null ? {} : { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: tracesEndpoint }),
    ...values,
    OTEL_RESOURCE_ATTRIBUTES: own === '' ? attributes : `${own},${attributes}`,
  };
}
