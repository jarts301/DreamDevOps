import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { EventBus, type JobQueue } from '@dreamdevops/shared-kernel';
import { ProvisioningService } from '../tenancy/application/provisioning.service.ts';
import { RepositoryService } from '../tenancy/application/repositories.service.ts';

export const JOB_QUEUE = Symbol('JOB_QUEUE');
export const OUTBOX_RELAY = Symbol('OUTBOX_RELAY');
/** Connects as the dreamdevops_relay role, the only one that reads events across companies. */
export const RELAY_POOL = Symbol('RELAY_POOL');

/** The part of the outbox relay the application starts and stops. */
export interface Relay {
  start(): void;
  stop(): Promise<void>;
}

/** A job queue that may hold connections to release at shutdown. */
export type ApplicationJobQueue = JobQueue & { stop?(): Promise<void> };

/**
 * Moves saved events from the outbox to the modules that subscribe to them. Subscribers
 * are registered before the relay starts, so no event is published before anyone listens.
 */
@Injectable()
export class BackgroundWork implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #bus: EventBus;
  readonly #relay: Relay;
  readonly #queue: ApplicationJobQueue;
  readonly #provisioning: ProvisioningService;
  readonly #repositories: RepositoryService;

  constructor(
    @Inject(EventBus) bus: EventBus,
    @Inject(OUTBOX_RELAY) relay: Relay,
    @Inject(JOB_QUEUE) queue: ApplicationJobQueue,
    @Inject(ProvisioningService) provisioning: ProvisioningService,
    @Inject(RepositoryService) repositories: RepositoryService,
  ) {
    this.#bus = bus;
    this.#relay = relay;
    this.#queue = queue;
    this.#provisioning = provisioning;
    this.#repositories = repositories;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.#provisioning.subscribe(this.#bus);
    await this.#repositories.subscribe(this.#bus);
    this.#relay.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#relay.stop();
    await this.#queue.stop?.();
  }
}
