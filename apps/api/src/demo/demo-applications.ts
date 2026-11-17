import { parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { ApplicationCatalog, ApplicationType, BlueprintChoice } from '../catalog/application/application-catalog.ts';
import type { Environments } from '../environments/application/environments.ts';
import { LOCAL_PROVIDER } from '../environments/domain/hosting-providers.ts';
import type { Principal } from '../identity-access/domain/access.ts';

/** The test environment the demo applications share, to deploy them to and try things out. */
export const DEMO_ENVIRONMENT_NAME = 'Test';

/** How each type's applications are named, after their framework and language. */
const TYPE_WORDS: Readonly<Record<string, string>> = {
  'restful-service': 'API',
  'web-frontend': 'Frontend',
};

/** One demo application: a type of application, in one language, on one framework. */
export interface DemoApplication {
  readonly name: string;
  readonly type: string;
  readonly blueprint: string;
  readonly description: string;
}

export interface DemoApplicationsResult {
  /** The applications registered now. Those already there, archived or not, are left as they are. */
  readonly registered: number;
  readonly total: number;
  /** Whether the Test environment was added now. */
  readonly environmentCreated: boolean;
  /** Whether it was connected to This machine now. */
  readonly environmentConnected: boolean;
}

/**
 * The demo applications: one for each type of application, language and framework
 * there's a blueprint for, such as "Axum Rust API" or "React TypeScript Frontend".
 */
export function demoApplications(types: readonly ApplicationType[]): DemoApplication[] {
  return types.flatMap((type) =>
    type.blueprints.map((blueprint) => ({
      name: `${frameworkName(blueprint)} ${blueprint.language} ${TYPE_WORDS[type.key] ?? type.name}`,
      type: type.key,
      blueprint: blueprint.key,
      description:
        `A demo ${type.name}, in ${blueprint.language} with ${blueprint.framework}, from the ${blueprint.key} blueprint. ` +
        `Build it, and deploy it to ${DEMO_ENVIRONMENT_NAME}, to try DreamDevOps out.`,
    })),
  );
}

/** A framework's name without its version or what it runs on, such as Express for "Express 5 on Node.js 24". */
function frameworkName(blueprint: BlueprintChoice): string {
  return blueprint.framework.split(/,| \d| on /)[0]!.trim();
}

/**
 * Makes sure the demo company has a demo application for each blueprint, and a Test
 * environment on This machine to deploy them to, when This machine is available. They're
 * registered by the Tech Lead, as a person would, so their repositories are created from
 * their blueprints as for any application.
 *
 * Safe to run on every start. What exists is left as it is: applications are found by
 * name, archived or not, and the environment by name. So one someone archived, or
 * connected elsewhere, stays that way.
 */
export async function seedDemoApplications(
  dependencies: { readonly catalog: ApplicationCatalog; readonly environments: Environments },
  companyId: string,
  techLead: Principal,
): Promise<DemoApplicationsResult> {
  const { catalog, environments } = dependencies;
  return runWithCompany(parseCompanyId(companyId), async () => {
    const all = [...(await environments.list('active')), ...(await environments.list('archived'))];
    let environment = all.find((candidate) => candidate.name.toLowerCase() === DEMO_ENVIRONMENT_NAME.toLowerCase());
    const environmentCreated = environment === undefined;
    environment ??= await environments.create(techLead, { name: DEMO_ENVIRONMENT_NAME, kind: 'test' });
    let environmentConnected = false;
    const local = environments.providers().find((provider) => provider.key === LOCAL_PROVIDER);
    if (environmentCreated && local?.unavailableReason === null) {
      await environments.connect(techLead, environment.id, { provider: LOCAL_PROVIDER });
      environmentConnected = true;
    }

    const existing = [...(await catalog.list('active')), ...(await catalog.list('archived'))];
    const samples = demoApplications(await catalog.types());
    let registered = 0;
    for (const sample of samples) {
      if (!existing.some((candidate) => candidate.name.toLowerCase() === sample.name.toLowerCase())) {
        await catalog.register(techLead, sample);
        registered += 1;
      }
    }
    return { registered, total: samples.length, environmentCreated, environmentConnected };
  });
}
