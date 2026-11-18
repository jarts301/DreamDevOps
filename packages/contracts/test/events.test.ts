import { parseCompanyId } from '@dreamdevops/shared-kernel';
import { describe, expect, it } from 'vitest';
import { AlertResolved, AlertTriggered, AlertUpdated } from '../src/alerts/events.ts';
import { ApplicationRegistered, ApplicationUpdated } from '../src/catalog/events.ts';
import { EnvironmentUpdated } from '../src/environments/events.ts';
import { CompanyEditionChanged } from '../src/editions/events.ts';
import { describeRecordedEvent, EVENT_CATALOG, summarizeRecordedEvent } from '../src/events.ts';
import { RoleGranted } from '../src/identity-access/events.ts';
import { CompanyRenamed } from '../src/tenancy/events.ts';

const companyId = parseCompanyId('a1b2c3d4-0000-4000-8000-00000000000a');
const someone = 'a1b2c3d4-0000-4000-8000-0000000000ff';
const application = 'a1b2c3d4-0000-4000-8000-0000000000a1';

const alert = {
  alertId: 'a1b2c3d4-0000-4000-8000-0000000000b1',
  name: 'High CPU',
  environmentId: 'a1b2c3d4-0000-4000-8000-0000000000e1',
  environmentName: 'Live',
  applicationId: application,
  applicationName: 'Billing API',
  production: true,
  metric: 'cpu' as const,
  comparator: 'above' as const,
  threshold: 80,
  forMinutes: 5,
  condition: 'CPU above 80%',
};

describe('the event catalog', () => {
  it('has each event type once, each with a description people can read', () => {
    const types = [...EVENT_CATALOG.keys()];

    expect(types.length).toBeGreaterThan(50);
    for (const definition of EVENT_CATALOG.values()) {
      expect(definition.description, definition.type).toMatch(/^[A-Z].+[^.]$/);
      expect(definition.version, definition.type).toBeGreaterThanOrEqual(1);
    }
  });

  it('describes a recorded event for the history, as whoever caused it did it', () => {
    expect(describeRecordedEvent('RoleGranted', { userId: someone, role: 'tech-lead', invitationId: someone })).toBe('Joined as Tech Lead');
    expect(describeRecordedEvent('RoleGranted', { userId: someone, role: 'viewer', grantedBy: someone })).toBe(
      "Changed a member's role to Viewer",
    );
    expect(describeRecordedEvent('CompanyRenamed', { previousName: 'Old', name: 'New', renamedBy: someone })).toBe(
      'Renamed the company from "Old" to "New"',
    );
    expect(describeRecordedEvent('SomethingNew', {})).toBe('SomethingNew');
  });

  it('still names an event recorded in a shape it no longer reads, by its description', () => {
    expect(describeRecordedEvent('CompanyRenamed', { name: 'New' })).toBe('The company is renamed');
    expect(summarizeRecordedEvent('CompanyRenamed', { name: 'New' })).toBe('The company is renamed.');
  });

  it('summarizes an event in a sentence, for chat', () => {
    expect(summarizeRecordedEvent('RoleGranted', { userId: someone, role: 'tech-lead', invitationId: someone })).toBe(
      'Someone joined as Tech Lead.',
    );
    expect(summarizeRecordedEvent('RoleGranted', { userId: someone, role: 'viewer' })).toBe("A member's role changed to Viewer.");
    expect(summarizeRecordedEvent('ApplicationRegistered', { applicationId: application, name: 'Billing', slug: 'billing', type: 'web' })).toBe(
      'The application "Billing" was registered.',
    );
    expect(summarizeRecordedEvent('SomethingNew', {})).toBe('SomethingNew happened.');
  });

  it('words application, edition and alert events as people read them', () => {
    expect(ApplicationUpdated.summarize({ applicationId: application, name: 'Payments', previousName: 'Billing', descriptionChanged: false })).toBe(
      'The application "Billing" was renamed to "Payments".',
    );
    expect(ApplicationUpdated.summarize({ applicationId: application, descriptionChanged: true })).toBe("An application's description changed.");
    expect(CompanyEditionChanged.summarize({ edition: 'commercial', previousEdition: 'community', changedBy: someone })).toBe(
      'The company moved to the Commercial Edition.',
    );
    expect(
      AlertTriggered.summarize({ ...alert, incidentId: someone, measured: 92, value: '92%', firingSince: '2026-11-10T12:00:00.000Z' }),
    ).toBe('The alert "High CPU" is firing: Billing API in the production environment "Live" has CPU above 80%, at 92%.');
    expect(
      AlertResolved.summarize({
        ...alert,
        incidentId: someone,
        measured: 12,
        value: '12%',
        firingSince: '2026-11-10T12:00:00.000Z',
        resolvedAt: '2026-11-10T12:10:00.000Z',
      }),
    ).toBe('The alert "High CPU" is resolved: Billing API in the production environment "Live" no longer has CPU above 80%, at 12%.');
    expect(AlertUpdated.describe({ ...alert, enabled: false, recipients: 2, changes: ['threshold', 'recipients', 'enabled'] })).toBe(
      'Changed the alert "High CPU" for Billing API in the production environment "Live": its threshold and whom it emails, and turned it off',
    );
  });

  it('says which environment setting changed, including whether production needs approval', () => {
    const environmentId = alert.environmentId;

    expect(EnvironmentUpdated.describe({ environmentId, name: 'Live', previousName: 'Prod', reason: 'Clearer' })).toBe(
      'Renamed the environment "Prod" to "Live", because "Clearer"',
    );
    expect(EnvironmentUpdated.describe({ environmentId, acceptsFeatureImages: true })).toBe('Let an environment accept feature images');
    expect(EnvironmentUpdated.describe({ environmentId, requiresApproval: true, reason: 'Policy' })).toBe(
      "Required a second person's approval for an environment's deployments, because \"Policy\"",
    );
  });
});

describe('an event contract', () => {
  it('creates events with its type and version, and refuses a payload that breaks it', () => {
    const event = CompanyRenamed.create({ companyId, actorId: someone, payload: { name: 'New', previousName: 'Old', renamedBy: someone } });

    expect(event).toMatchObject({ eventType: 'CompanyRenamed', eventVersion: 1, companyId, actorId: someone });
    expect(() => CompanyRenamed.create({ companyId, payload: { name: '', previousName: 'Old', renamedBy: someone } })).toThrow(
      "doesn't hold to its contract",
    );
  });

  it('refuses a field its publisher forgot to put in the contract, rather than drop it', () => {
    const payload = { applicationId: application, name: 'Billing', slug: 'billing', type: 'web', owner: 'someone' };

    expect(() => ApplicationRegistered.create({ companyId, payload: payload as never })).toThrow('owner');
  });

  it("reads an event for a consumer, who doesn't mind fields added since, and refuses one that breaks it", () => {
    const event = RoleGranted.create({ companyId, payload: { userId: someone, role: 'viewer' } });

    expect(RoleGranted.parse({ ...event, payload: { ...event.payload, addedLater: true } }).payload).toEqual({ userId: someone, role: 'viewer' });
    expect(() => RoleGranted.parse({ ...event, payload: { role: 'viewer' } })).toThrow('userId');
    expect(() => RoleGranted.parse({ ...event, eventVersion: 2 })).toThrow('version is 2');
    expect(() => RoleGranted.parse({ ...event, eventType: 'MemberRemoved' })).toThrow('not RoleGranted');
  });
});
