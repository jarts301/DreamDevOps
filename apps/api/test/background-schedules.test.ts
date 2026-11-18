import { BuildRequested } from '@dreamdevops/contracts/builds/events';
import { createDomainEvent, EventBus, parseCompanyId } from '@dreamdevops/shared-kernel';
import type { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { InMemoryJobQueue } from '@dreamdevops/shared-kernel/testing';
import { describe, expect, it, vi } from 'vitest';
import type { Builds } from '../src/builds/application/builds.ts';
import { BuildsSubscriptions, EXPIRE_QUEUE } from '../src/builds/messaging/builds-subscriptions.ts';
import type { Deployments } from '../src/deployments/application/deployments.ts';
import { DeploymentsSubscriptions, STALLED_QUEUE } from '../src/deployments/messaging/deployments-subscriptions.ts';
import type { SecretStore } from '../src/environments/application/ports.ts';
import type { TargetAgents } from '../src/environments/application/target-agents.ts';
import type { TargetConfigurations } from '../src/environments/application/target-configuration.ts';
import {
  EnvironmentsSubscriptions,
  LOST_TARGETS_QUEUE,
  RENEWAL_QUEUE,
} from '../src/environments/messaging/environments-subscriptions.ts';
import type { Releases } from '../src/releases/application/releases.ts';
import { ReleasesSubscriptions, SYNC_QUEUE } from '../src/releases/messaging/releases-subscriptions.ts';
import type { Repositories } from '../src/source-governance/application/repositories.ts';
import type { SourceAccess } from '../src/source-governance/application/source-access.ts';
import { SourceGovernanceSubscriptions, UPGRADE_QUEUE } from '../src/source-governance/messaging/source-governance-subscriptions.ts';
import { testConfig } from './test-app.ts';

const config = testConfig();
const companyId = parseCompanyId('a1b2c3d4-0000-4000-8000-00000000000a');

/** One API process: its own event bus on the job queue every process shares. */
const processOn = (queue: InMemoryJobQueue) => ({ bus: new EventBus(queue), queue });

describe('background sweeps', () => {
  it('run on schedules every process shares, not on timers in each process', async () => {
    const queue = new InMemoryJobQueue();
    const builds = { expireStale: vi.fn(async () => {}) };
    const deployments = { failStalled: vi.fn(async () => {}) };
    const releases = { syncAll: vi.fn(async () => {}) };
    const agents = { markSilentTargetsLost: vi.fn(async () => {}) };
    const secrets = { renew: vi.fn(async () => {}) };
    const work = processOn(queue);

    await new BuildsSubscriptions(builds as unknown as Builds, config).subscribe(work);
    await new DeploymentsSubscriptions(deployments as unknown as Deployments, config).subscribe(work);
    await new ReleasesSubscriptions(releases as unknown as Releases, config).subscribe(work);
    await new EnvironmentsSubscriptions(
      agents as unknown as TargetAgents,
      {} as TargetConfigurations,
      secrets as unknown as SecretStore,
      config,
    ).subscribe(work);

    expect(Object.fromEntries([...queue.schedulesOf()].map(([name, { cron }]) => [name, cron]))).toEqual({
      [EXPIRE_QUEUE]: '* * * * *',
      [STALLED_QUEUE]: '* * * * *',
      [SYNC_QUEUE]: '*/5 * * * *',
      [LOST_TARGETS_QUEUE]: '* * * * *',
      [RENEWAL_QUEUE]: '0 */6 * * *',
    });
    // The token is renewed at start, as well as on its schedule.
    expect(secrets.renew).toHaveBeenCalledTimes(1);

    await queue.runSchedules();

    expect(builds.expireStale).toHaveBeenCalledTimes(1);
    expect(deployments.failStalled).toHaveBeenCalledTimes(1);
    expect(releases.syncAll).toHaveBeenCalledTimes(1);
    expect(agents.markSilentTargetsLost).toHaveBeenCalledTimes(1);
    expect(secrets.renew).toHaveBeenCalledTimes(2);
  });

  it('bring repositories up to date once per version of the rules, however many processes start', async () => {
    const queue = new InMemoryJobQueue();
    const transaction = vi.fn(async () => []);
    const subscriptions = () =>
      new SourceGovernanceSubscriptions(
        { upgradePolicies: vi.fn() } as unknown as Repositories,
        {} as SourceAccess,
        config,
        { transaction } as unknown as TenantDatabase,
      );

    await subscriptions().subscribe(processOn(queue));
    await subscriptions().subscribe(processOn(queue));
    await queue.drain();

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(queue.deadLettersOf(UPGRADE_QUEUE)).toEqual([]);
  });
});

describe('events from other modules', () => {
  it("are checked against their contract, and go to the dead letter queue when they don't hold to it", async () => {
    const queue = new InMemoryJobQueue();
    const builds = { start: vi.fn(async () => {}) };
    const work = processOn(queue);
    await new BuildsSubscriptions(builds as unknown as Builds, config).subscribe(work);

    const requested = BuildRequested.create({
      companyId,
      payload: {
        buildId: '00000000-0000-4000-8000-0000000000b1',
        applicationId: '00000000-0000-4000-8000-0000000000a1',
        kind: 'feature',
        branch: 'feature/login',
        commit: 'a'.repeat(40),
        tag: 'feature-login',
        version: null,
      },
    });
    await work.bus.publish(requested);
    // Made by hand, the way a publisher with the wrong contract might, without its build's ID.
    await work.bus.publish(createDomainEvent({ eventType: 'BuildRequested', companyId, payload: { applicationId: requested.payload.applicationId } }));
    await queue.drain();

    expect(builds.start.mock.calls).toEqual([[requested.payload.buildId]]);
    expect(queue.deadLettersOf('events.builds.BuildRequested')).toHaveLength(1);
  });
});
