import type { DomainEvent, EventContract } from '../src/index.ts';

/**
 * A contract for tests, with no schema library: events of its type hold to it when their
 * payload passes the check. Contexts' real contracts are in the contracts package.
 */
export function contractFor(
  type: string,
  check: (payload: Record<string, unknown>) => void = () => {},
  version = 1,
): EventContract {
  return {
    type,
    version,
    parse(event: DomainEvent): DomainEvent {
      check(event.payload as Record<string, unknown>);
      return event;
    },
  };
}
