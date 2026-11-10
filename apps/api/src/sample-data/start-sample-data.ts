import { type INestApplicationContext, Logger } from '@nestjs/common';
import type { AppConfig } from '../config/app-config.ts';
import { CompanyAccessService } from '../identity-access/application/company-access.service.ts';
import { USER_DIRECTORY, type UserDirectory } from '../identity-access/application/ports.ts';
import { CompaniesService } from '../tenancy/application/companies.service.ts';
import { KeycloakAdmin } from './keycloak-admin.ts';
import { seedSampleCompany } from './sample-company.ts';

/**
 * Sets up the sample company when SAMPLE_DATA is on, which the local start script turns
 * on. A failure is reported, but doesn't stop the API: it works without sample data.
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
  } catch (error) {
    logger.warn(`The sample company couldn't be set up: ${error instanceof Error ? error.message : String(error)}`);
  }
}
