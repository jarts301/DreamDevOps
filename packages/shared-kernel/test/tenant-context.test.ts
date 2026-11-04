import { describe, expect, it } from 'vitest';
import { currentCompanyId, MissingTenantContextError, parseCompanyId, runWithCompany } from '../src/index.ts';

const companyA = parseCompanyId('a1b2c3d4-0000-4000-8000-00000000000a');
const companyB = parseCompanyId('a1b2c3d4-0000-4000-8000-00000000000b');

describe('tenant context', () => {
  it('fails outside a company context', () => {
    expect(() => currentCompanyId()).toThrow(MissingTenantContextError);
  });

  it('follows asynchronous work', async () => {
    const seen = await runWithCompany(companyA, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentCompanyId();
    });

    expect(seen).toBe(companyA);
  });

  it('keeps concurrent requests apart', async () => {
    const seenBy = (companyId: typeof companyA, delayMs: number) =>
      runWithCompany(companyId, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return currentCompanyId();
      });

    await expect(Promise.all([seenBy(companyA, 10), seenBy(companyB, 1)])).resolves.toEqual([companyA, companyB]);
  });

  it('is cleared when the work ends', () => {
    runWithCompany(companyA, () => currentCompanyId());

    expect(() => currentCompanyId()).toThrow(MissingTenantContextError);
  });
});
