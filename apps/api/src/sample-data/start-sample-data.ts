import { type INestApplicationContext, Logger } from '@nestjs/common';
import type { AppConfig } from '../config/app-config.ts';
import { ApplicationCatalog } from '../catalog/application/application-catalog.ts';
import { Environments } from '../environments/application/environments.ts';
import { CompanyAccessService } from '../identity-access/application/company-access.service.ts';
import { USER_DIRECTORY, type UserDirectory } from '../identity-access/application/ports.ts';
import { CompaniesService } from '../tenancy/application/companies.service.ts';
import { KeycloakAdmin } from './keycloak-admin.ts';
import { SAMPLE_ENVIRONMENT_NAME, seedSampleApplications } from './sample-applications.ts';
import { seedSampleCompany } from './sample-company.ts';

/** Who registers the sample applications: the first of these roles a sample member has. */
const REGISTERING_ROLES = ['tech-lead', 'company-admin', 'operator'];

/**
 * Sets up the sample company when SAMPLE_DATA is on, which the local start script turns
 * on, and, unless SAMPLE_APPLICATIONS is off, its sample applications. A failure is
 * reported, but doesn't stop the API: it works without sample data.
 */
export async function startSampleData(app: INestApplicationContext, config: AppConfig): Promise<void> {
  if (config.sampleData === null) {
    return;
  }
  const logger = new Logger('SampleData');
  try {
    const result = await seedSampleCompany({
      users: new KeycloakAdmin({
        issuerUrl: config.keycloakIssuerUrl,
        username: config.sampleData.keycloakAdminUsername,
        password: config.sampleData.keycloakAdminPassword,
      }),
      directory: app.get<UserDirectory>(USER_DIRECTORY, { strict: false }),
      companies: app.get(CompaniesService, { strict: false }),
      access: app.get(CompanyAccessService, { strict: false }),
      password: config.sampleData.password,
    });
    const accounts = result.accounts
      .map((account) => `${account.username} (${account.actualRole}${account.accountCreated ? ', new' : ''})`)
      .join(', ');
    logger.log(
      `${result.companyName} is ready${result.companyCreated ? ', just created' : ''}. Sample accounts: ${accounts}. Their password is KEYCLOAK_DEV_USER_PASSWORD.`,
    );
    if (!config.sampleData.applications) {
      return;
    }
    const members = REGISTERING_ROLES.flatMap((role) => result.accounts.filter((account) => account.actualRole === role));
    const samples = await seedSampleApplications(
      {
        directory: app.get<UserDirectory>(USER_DIRECTORY, { strict: false }),
        catalog: app.get(ApplicationCatalog, { strict: false }),
        environments: app.get(Environments, { strict: false }),
      },
      result.companyId,
      members,
    );
    if (samples.registeredBy === null) {
      logger.warn('No sample member may register applications and add environments, so the sample applications were left out.');
      return;
    }
    const added = samples.applications.filter((application) => application.created).length;
    const environments = samples.applications.filter((application) => application.environmentCreated).length;
    logger.log(
      `${samples.applications.length} sample applications are ready, one for each type, language and framework, each with a ${SAMPLE_ENVIRONMENT_NAME} environment` +
        (added + environments === 0 ? '.' : `. ${samples.registeredBy} added ${added} applications and ${environments} environments.`),
    );
  } catch (error) {
    logger.warn(`The sample company couldn't be set up: ${error instanceof Error ? error.message : String(error)}`);
  }
}
