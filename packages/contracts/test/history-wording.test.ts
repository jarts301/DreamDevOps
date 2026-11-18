import { describe, expect, it } from 'vitest';
import { AlertCreated, AlertDeleted, AlertResolved, AlertTriggered, AlertUpdated } from '../src/alerts/events.ts';
import { BuildSucceeded } from '../src/builds/events.ts';
import { ApplicationArchived, ApplicationRegistered, ApplicationUpdated } from '../src/catalog/events.ts';
import { DeploymentRequested, DeploymentSucceeded } from '../src/deployments/events.ts';
import { CompanyEditionChanged } from '../src/editions/events.ts';
import { EnvironmentCreated, EnvironmentSecretSet, EnvironmentUpdated, TargetConnected, TargetLost, TargetRevoked } from '../src/environments/events.ts';
import { ReleasePublished } from '../src/releases/events.ts';
import { RepositoryCreated, RepositoryCreationFailed } from '../src/source-governance/events.ts';
import { PullRequestMerged } from '../src/webhooks/events.ts';

/**
 * How the history words each change, as the dashboard used to word it itself before the
 * API sent each entry's description. People read these, so they must not change by accident.
 */

const applicationId = 'a1b2c3d4-0000-4000-8000-0000000000a1';
const environmentId = 'a1b2c3d4-0000-4000-8000-0000000000e1';
const someId = 'a1b2c3d4-0000-4000-8000-0000000000ff';
const commit = 'a'.repeat(40);

const place = {
  alertId: someId,
  environmentId,
  environmentName: 'Production',
  applicationId,
  applicationName: 'Billing API',
  production: true,
  metric: 'cpu' as const,
  comparator: 'above' as const,
  threshold: 80,
  forMinutes: 5,
  condition: 'CPU above 80%',
};

describe('the history', () => {
  it('words changes to applications and their repositories', () => {
    expect(ApplicationRegistered.describe({ applicationId, name: 'Billing', slug: 'billing', type: 'web' })).toBe(
      'Registered the application "Billing"',
    );
    expect(ApplicationUpdated.describe({ applicationId, name: 'Payments', previousName: 'Billing', descriptionChanged: false })).toBe(
      'Renamed the application "Billing" to "Payments"',
    );
    expect(ApplicationUpdated.describe({ applicationId, descriptionChanged: true })).toBe("Changed an application's description");
    expect(ApplicationArchived.describe({ applicationId, name: 'Billing' })).toBe('Archived the application "Billing"');
    expect(
      RepositoryCreated.describe({ applicationId, name: 'Billing', repository: 'acme/billing', blueprint: 'node', blueprintVersion: '1.0.0' }),
    ).toBe('Created the repository acme/billing for "Billing"');
    expect(RepositoryCreationFailed.describe({ applicationId, name: 'Billing', reason: 'Name taken' })).toBe(
      'Creating the repository of "Billing" failed: Name taken',
    );
  });

  it('words editions, builds and releases', () => {
    expect(CompanyEditionChanged.describe({ edition: 'commercial', previousEdition: 'community', changedBy: someId })).toBe(
      'Moved the company from the Community to the Commercial Edition',
    );
    expect(
      BuildSucceeded.describe({
        buildId: someId,
        applicationId,
        kind: 'final',
        branch: null,
        commit,
        tag: '1.0.0',
        version: '1.0.0',
        releaseId: someId,
        imageRef: null,
        digest: null,
        signedWith: 'release',
      }),
    ).toBe('Built, scanned and signed the image 1.0.0');
    expect(PullRequestMerged.describe({ applicationId, number: 3, head: 'release/1.0.0', base: 'main', mergeCommit: commit })).toBe(
      'Merged pull request #3 from release/1.0.0 into main',
    );
    expect(ReleasePublished.describe({ releaseId: someId, applicationId, version: '1.0.0', kind: 'release', buildId: someId })).toBe(
      'Published version 1.0.0',
    );
  });

  it('words environments, their targets and their values', () => {
    expect(
      EnvironmentCreated.describe({ environmentId, name: 'Live', slug: 'live', kind: 'production', acceptsFeatureImages: false }),
    ).toBe('Created the production environment "Live"');
    expect(EnvironmentUpdated.describe({ environmentId, acceptsFeatureImages: false })).toBe(
      'Stopped an environment from accepting feature images',
    );
    expect(
      TargetConnected.describe({ environmentId, environmentName: 'Live', targetId: someId, keyFingerprint: 'ab12:cd34:ef56:7890' }),
    ).toBe('Connected a target to "Live", key ab12:cd34:ef56:7890');
    expect(TargetConnected.describe({ environmentId, environmentName: 'Trial', targetId: someId, provider: 'local' })).toBe(
      'Set "Trial" to run on this machine',
    );
    expect(TargetLost.describe({ environmentId, environmentName: 'Live', targetId: someId, lastSeenAt: '2026-11-10T12:00:00.000Z' })).toBe(
      'The target of "Live" stopped reporting',
    );
    expect(
      TargetRevoked.describe({ environmentId, environmentName: 'Live', targetId: someId, provider: 'kubernetes', wasConnected: false }),
    ).toBe('Cancelled connecting a target to "Live"');
    expect(
      TargetRevoked.describe({
        environmentId,
        environmentName: 'Live',
        targetId: someId,
        provider: 'kubernetes',
        wasConnected: true,
        reason: 'Moving to the new cluster',
      }),
    ).toBe('Disconnected the target of "Live", because "Moving to the new cluster"');
    expect(EnvironmentSecretSet.describe({ environmentId, environmentName: 'Live', applicationId, name: 'API_KEY' })).toBe(
      'Set the secret API_KEY in "Live" for one application',
    );
  });

  it('words deployments, stops and applied values, with the reasons given for production', () => {
    const requested = {
      deploymentId: someId,
      applicationId,
      environmentId,
      buildId: someId,
      strategy: 'blue-green' as const,
      rollbackOf: null,
    };

    expect(DeploymentRequested.describe({ ...requested, environmentName: 'Live', action: 'deploy', needsApproval: true })).toBe(
      'Asked for a blue-green deployment to "Live", which needs approval',
    );
    expect(
      DeploymentRequested.describe({
        ...requested,
        environmentName: 'Live',
        action: 'stop',
        needsApproval: false,
        reason: 'Retiring the old API',
      }),
    ).toBe('Asked to stop an application in "Live", because "Retiring the old API"');
    expect(DeploymentRequested.describe({ ...requested, environmentName: 'Staging', action: 'apply', needsApproval: false })).toBe(
      'Asked to apply the values of "Staging" to what runs there',
    );
    expect(
      DeploymentSucceeded.describe({
        deploymentId: someId,
        applicationId,
        applicationName: 'Billing',
        environmentId,
        environmentName: 'Staging',
        version: '1.0.0',
        action: 'stop',
      }),
    ).toBe('Stopped Billing in "Staging"');
  });

  it('words alerts, where they watch and what changed', () => {
    expect(AlertCreated.describe({ ...place, name: 'High CPU', recipients: 1 })).toBe(
      'Created the alert "High CPU" on CPU above 80% for Billing API in the production environment "Production"',
    );
    expect(AlertUpdated.describe({ ...place, name: 'High CPU', recipients: 2, changes: ['threshold', 'recipients'], enabled: true })).toBe(
      'Changed the alert "High CPU" for Billing API in the production environment "Production": its threshold and whom it emails',
    );
    expect(AlertUpdated.describe({ ...place, name: 'High CPU', recipients: 2, changes: ['enabled'], enabled: false })).toBe(
      'Changed the alert "High CPU" for Billing API in the production environment "Production": turned it off',
    );
    const incident = { incidentId: someId, measured: 93, firingSince: '2026-11-10T12:00:00.000Z' };
    expect(AlertTriggered.describe({ ...place, ...incident, name: 'High CPU', value: '93%' })).toBe(
      'The alert "High CPU" fired: CPU above 80% for Billing API in the production environment "Production", at 93%',
    );
    expect(AlertResolved.describe({ ...place, ...incident, name: 'High CPU', value: '12%', resolvedAt: '2026-11-10T12:10:00.000Z' })).toBe(
      'The alert "High CPU" was resolved: CPU above 80% no longer holds for Billing API in the production environment "Production", at 12%',
    );
    expect(AlertDeleted.describe({ ...place, name: 'High CPU' })).toBe(
      'Deleted the alert "High CPU" for Billing API in the production environment "Production"',
    );
  });
});
