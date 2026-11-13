import { parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { ApplicationCatalog, ApplicationType, BlueprintChoice } from '../catalog/application/application-catalog.ts';
import type { Environments } from '../environments/application/environments.ts';
import type { UserDirectory } from '../identity-access/application/ports.ts';
import { hasPermissions, type Principal, toPrincipal } from '../identity-access/domain/access.ts';

/** The environment each sample application gets, to deploy to and try things out. */
export const SAMPLE_ENVIRONMENT_NAME = 'Test';

/** What registering applications and adding their environments takes. */
const NEEDED_PERMISSIONS = ['applications:create', 'environments:manage'];

/** How each type's applications are named, after their framework and language. */
const TYPE_WORDS: Readonly<Record<string, string>> = {
  'restful-service': 'API',
  'web-frontend': 'Frontend',
};

/** One sample application: a type of application, in one language, on one framework. */
export interface SampleApplication {
  readonly name: string;
  readonly type: string;
  readonly blueprint: string;
  readonly description: string;
}

export interface SampleApplicationsDependencies {
  readonly directory: UserDirectory;
  readonly catalog: ApplicationCatalog;
  readonly environments: Environments;
}

export interface SampleApplicationsResult {
  /** Who registered what was missing, or null when no sample member may. */
  readonly registeredBy: string | null;
  readonly applications: readonly {
    readonly name: string;
    readonly blueprint: string;
    /** Whether the application was registered now, rather than found. */
    readonly created: boolean;
    /** Whether its Test environment was added now. */
    readonly environmentCreated: boolean;
  }[];
}

/**
 * The sample applications: one for each type of application, language and framework
 * there's a blueprint for, such as "Axum Rust API" or "React TypeScript Frontend".
 */
export function sampleApplications(types: readonly ApplicationType[]): SampleApplication[] {
  return types.flatMap((type) =>
    type.blueprints.map((blueprint) => ({
      name: `${frameworkName(blueprint)} ${blueprint.language} ${TYPE_WORDS[type.key] ?? type.name}`,
      type: type.key,
      blueprint: blueprint.key,
      description:
        `A sample ${type.name}, in ${blueprint.language} with ${blueprint.framework}, from the ${blueprint.key} blueprint. ` +
        `Build it, and deploy it to ${SAMPLE_ENVIRONMENT_NAME}, to try DreamDevOps out.`,
    })),
  );
}

/** A framework's name without its version or what it runs on, such as Express for "Express 5 on Node.js 24". */
function frameworkName(blueprint: BlueprintChoice): string {
  return blueprint.framework.split(/,| \d| on /)[0]!.trim();
}

/**
 * Makes sure the sample company has a sample application for each type, language and
 * framework, each with a Test environment on This machine. They're registered as people
 * would, by a sample member who may, so their repositories are created, from their
 * blueprint, as for any application.
 *
 * Safe to run on every start. What exists is left as it is: an application is looked up
 * by its name, archived or not, and an environment by its name in the application. So an
 * application or environment someone archived stays archived.
 */
export async function seedSampleApplications(
  dependencies: SampleApplicationsDependencies,
  companyId: string,
  /** The sample members, in the order they're asked to register: the first who may does. */
  members: readonly { readonly username: string; readonly userId: string }[],
): Promise<SampleApplicationsResult> {
  const { directory, catalog, environments } = dependencies;
  let actor: { username: string; principal: Principal } | null = null;
  for (const member of members) {
    const access = await directory.loadAccess(member.userId);
    const principal = access === null ? null : toPrincipal(access, companyId);
    if (principal !== null && principal.companyId === companyId && hasPermissions(principal, NEEDED_PERMISSIONS)) {
      actor = { username: member.username, principal };
      break;
    }
  }
  if (actor === null) {
    return { registeredBy: null, applications: [] };
  }
  const { principal } = actor;

  return runWithCompany(parseCompanyId(companyId), async () => {
    const existing = [...(await catalog.list('active')), ...(await catalog.list('archived'))];
    const applications: SampleApplicationsResult['applications'][number][] = [];
    for (const sample of sampleApplications(await catalog.types())) {
      let application = existing.find((candidate) => candidate.name.toLowerCase() === sample.name.toLowerCase());
      const created = application === undefined;
      application ??= await catalog.register(principal, sample);
      let environmentCreated = false;
      if (application.status === 'active') {
        const current = [
          ...(await environments.list(application.id, 'active')),
          ...(await environments.list(application.id, 'archived')),
        ];
        if (!current.some((environment) => environment.name.toLowerCase() === SAMPLE_ENVIRONMENT_NAME.toLowerCase())) {
          await environments.create(principal, application.id, { name: SAMPLE_ENVIRONMENT_NAME, production: false });
          environmentCreated = true;
        }
      }
      applications.push({ name: sample.name, blueprint: sample.blueprint, created, environmentCreated });
    }
    return { registeredBy: actor.username, applications };
  });
}
