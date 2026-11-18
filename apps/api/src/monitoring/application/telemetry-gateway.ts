import { runWithCompany } from '@dreamdevops/shared-kernel';
import type { ApplicationCatalog } from '../../catalog/application/application-catalog.ts';
import type { TargetAgents } from '../../environments/application/target-agents.ts';
import { COMPANY_ATTRIBUTE, PLATFORM_ATTRIBUTE_PREFIX, placeAttributes } from '../../environments/domain/telemetry.ts';
import { MonitoringError } from '../domain/errors.ts';
import type { TelemetryKind, TelemetrySink } from './ports.ts';

/** Where each kind of OTLP request keeps its resources. */
const RESOURCES: Readonly<Record<TelemetryKind, string>> = {
  metrics: 'resourceMetrics',
  traces: 'resourceSpans',
  logs: 'resourceLogs',
};
/** The namespace an application runs in, which the cluster's collector adds. Each application has its own, named by its short name. */
const NAMESPACE_ATTRIBUTE = 'k8s.namespace.name';

interface Attribute {
  key: string;
  value: Record<string, unknown>;
}

interface Resource {
  resource?: { attributes?: Attribute[] };
}

export function parseTelemetryKind(value: unknown): TelemetryKind {
  if (value !== 'metrics' && value !== 'traces' && value !== 'logs') {
    throw new MonitoringError('not-found', 'Telemetry is metrics, traces or logs.');
  }
  return value;
}

/**
 * Takes the metrics, traces and logs a target's collector sends, and is the authority on
 * where they come from. The collector proves which target it is with its telemetry token,
 * and the platform knows that target's environment and company. Each resource is then
 * labelled with them, and with its application, found by the namespace it ran in, whatever
 * the application said about itself. So no application can send as another environment,
 * application or company. Resources from namespaces that aren't the company's
 * applications, such as the cluster's own tools, are dropped.
 */
export class TelemetryGateway {
  readonly #agents: TargetAgents;
  readonly #catalog: ApplicationCatalog;
  readonly #sink: TelemetrySink | null;

  constructor(agents: TargetAgents, catalog: ApplicationCatalog, sink: TelemetrySink | null) {
    this.#agents = agents;
    this.#catalog = catalog;
    this.#sink = sink;
  }

  /** Checks, labels and forwards one OTLP request. Returns how many resources it kept and dropped. */
  async receive(kindValue: unknown, token: string | undefined, body: unknown): Promise<{ kept: number; dropped: number }> {
    const kind = parseTelemetryKind(kindValue);
    const { companyId, environmentId } = await this.#agents.authenticateTelemetry(token);
    const resources = (body as Record<string, unknown> | null)?.[RESOURCES[kind]];
    if (!Array.isArray(resources)) {
      throw new MonitoringError('invalid', `This isn't an OTLP ${kind} request in JSON.`);
    }
    const namespaceOf = (entry: Resource): unknown =>
      (entry.resource?.attributes ?? []).find((attribute) => attribute.key === NAMESPACE_ATTRIBUTE)?.value['stringValue'];
    // Only the applications this batch names are looked up, rather than all of the company's, for every batch.
    const namespaces = (resources as Resource[]).map(namespaceOf).filter((namespace): namespace is string => typeof namespace === 'string');
    const applications = await runWithCompany(companyId, () => this.#catalog.idsBySlug(namespaces));
    const kept = (resources as Resource[]).flatMap((entry) => {
      const attributes = entry.resource?.attributes ?? [];
      const namespace = namespaceOf(entry);
      const applicationId = typeof namespace === 'string' ? applications.get(namespace) : undefined;
      if (applicationId === undefined) {
        return [];
      }
      const labels = { ...placeAttributes(environmentId, applicationId), [COMPANY_ATTRIBUTE]: companyId };
      return [
        {
          ...entry,
          resource: {
            ...entry.resource,
            attributes: [
              ...attributes.filter((attribute) => !attribute.key.startsWith(PLATFORM_ATTRIBUTE_PREFIX)),
              ...Object.entries(labels).map(([key, value]) => ({ key, value: { stringValue: value } })),
            ],
          },
        },
      ];
    });
    if (kept.length > 0 && this.#sink !== null) {
      await this.#sink.send(kind, { ...(body as object), [RESOURCES[kind]]: kept });
    }
    return { kept: kept.length, dropped: resources.length - kept.length };
  }
}
