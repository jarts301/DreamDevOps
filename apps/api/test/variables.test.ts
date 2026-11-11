import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDomainEvent, parseCompanyId } from '@dreamdevops/shared-kernel';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox, SecretUnreadableError } from '../src/environments/domain/secret-box.ts';
import { ENVIRONMENT_ATTRIBUTE, withTelemetry } from '../src/environments/domain/telemetry.ts';
import {
  assertWithinLimits,
  MAX_TOTAL_BYTES,
  MAX_VARIABLES,
  parseVariableName,
  parseVariableValue,
  platformVariables,
} from '../src/environments/domain/variables.ts';
import { envFileText } from '../src/environments/infrastructure/local-docker-runtime.ts';
import { loadSecretsKey } from '../src/environments/infrastructure/secrets-key-file.ts';
import { summarize } from '../src/notifications/domain/event-catalog.ts';
import { COMPANY_A } from './fakes.ts';
import { signIn } from './support/integration.ts';
import { createTestApp } from './test-app.ts';

const scratch: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), 'dreamdevops-test-'));
  scratch.push(directory);
  return directory;
};
afterAll(() => {
  for (const directory of scratch) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('variable names', () => {
  it('are what containers and shells accept', () => {
    expect(parseVariableName(' DATABASE_URL ')).toBe('DATABASE_URL');
    expect(parseVariableName('_private')).toBe('_private');
    expect(parseVariableName('logLevel2')).toBe('logLevel2');
    for (const bad of ['', '2FA', 'WITH-DASH', 'WITH SPACE', 'É', 'A'.repeat(129), 42]) {
      expect(() => parseVariableName(bad), String(bad)).toThrow('Use a name of letters, digits and underscores');
    }
  });

  it('leave the platform’s and the container’s own to them', () => {
    for (const reserved of ['DREAMDEVOPS_VERSION', 'dreamdevops_anything', 'PATH', 'hostname']) {
      expect(() => parseVariableName(reserved)).toThrow("is set by the platform or the container, so it can't be set here.");
    }
  });
});

describe('variable values', () => {
  it('are kept exactly as given, spaces and all', () => {
    expect(parseVariableValue('  padded = yes  ', { secret: false })).toBe('  padded = yes  ');
    expect(parseVariableValue('', { secret: false })).toBe('');
    expect(parseVariableValue('päss wörd ✓', { secret: true })).toBe('päss wörd ✓');
  });

  it('fit on one line, and secrets aren’t empty', () => {
    expect(() => parseVariableValue('line one\nline two', { secret: false })).toThrow(
      'Values must fit on one line. Encode multi-line values, such as keys, in base64.',
    );
    expect(() => parseVariableValue('a\rb', { secret: true })).toThrow('Values must fit on one line.');
    expect(() => parseVariableValue('', { secret: true })).toThrow('Enter the secret’s value.');
    expect(() => parseVariableValue('\u0000', { secret: false })).toThrow('characters a container can’t be given');
    expect(() => parseVariableValue('\ud800', { secret: false })).toThrow('characters a container can’t be given');
    expect(() => parseVariableValue(undefined, { secret: false })).toThrow('Enter a value.');
    expect(() => parseVariableValue('x'.repeat(32 * 1024 + 1), { secret: false })).toThrow('Keep each value under 32 KB.');
  });

  it('are limited in number and total size per environment', () => {
    expect(() => assertWithinLimits(Array.from({ length: MAX_VARIABLES }, () => 10))).not.toThrow();
    expect(() => assertWithinLimits(Array.from({ length: MAX_VARIABLES + 1 }, () => 1))).toThrow('up to 100 variables and secrets');
    expect(() => assertWithinLimits([MAX_TOTAL_BYTES, 1])).toThrow('can total up to 256 KB');
  });

  it('come with the platform’s own, which say where and what runs', () => {
    expect(platformVariables({ slug: 'staging', production: false }, '1.5.0-rc.2')).toEqual({
      DREAMDEVOPS_ENVIRONMENT: 'staging',
      DREAMDEVOPS_PRODUCTION: 'false',
      DREAMDEVOPS_VERSION: '1.5.0-rc.2',
    });
  });

  const targets = (metricsEndpoint: string | null, tracesEndpoint: string | null) => ({
    environmentId: 'env-1',
    serviceName: 'billing-api',
    metricsEndpoint,
    tracesEndpoint,
  });
  const METRICS = 'http://host.docker.internal:9090/api/v1/otlp/v1/metrics';
  const TRACES = 'http://host.docker.internal:4318/v1/traces';

  it('tell the container where to send its metrics and traces, and which environment and service it is', () => {
    expect(withTelemetry({ LOG_LEVEL: 'debug' }, targets(METRICS, TRACES))).toEqual({
      LOG_LEVEL: 'debug',
      OTEL_SERVICE_NAME: 'billing-api',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: METRICS,
      OTEL_METRIC_EXPORT_INTERVAL: '15000',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: TRACES,
      OTEL_RESOURCE_ATTRIBUTES: 'dreamdevops.environment.id=env-1',
    });
    expect(ENVIRONMENT_ATTRIBUTE).toBe('dreamdevops.environment.id');
  });

  it('tell the container only about what the platform keeps', () => {
    expect(withTelemetry({}, targets(METRICS, null))).toEqual({
      OTEL_SERVICE_NAME: 'billing-api',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: METRICS,
      OTEL_METRIC_EXPORT_INTERVAL: '15000',
      OTEL_RESOURCE_ATTRIBUTES: 'dreamdevops.environment.id=env-1',
    });
    expect(withTelemetry({}, targets(null, TRACES))).toEqual({
      OTEL_SERVICE_NAME: 'billing-api',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: TRACES,
      OTEL_RESOURCE_ATTRIBUTES: 'dreamdevops.environment.id=env-1',
    });
  });

  it('add nothing when the platform keeps neither metrics nor traces', () => {
    expect(withTelemetry({ LOG_LEVEL: 'debug' }, targets(null, null))).toEqual({ LOG_LEVEL: 'debug' });
  });

  it('let the environment send them elsewhere, under another name, but always say which environment it is', () => {
    const own = {
      OTEL_SERVICE_NAME: 'billing',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://metrics.example.com/v1/metrics',
      OTEL_METRIC_EXPORT_INTERVAL: '60000',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example.com/v1/traces',
      OTEL_RESOURCE_ATTRIBUTES: ' team=billing,dreamdevops.environment.id=someone-else ',
    };

    expect(withTelemetry(own, targets(METRICS, TRACES))).toEqual({
      ...own,
      // The last one counts, so the environment's own ID wins.
      OTEL_RESOURCE_ATTRIBUTES: 'team=billing,dreamdevops.environment.id=someone-else,dreamdevops.environment.id=env-1',
    });
  });

  it('reach Docker as an env file, one per line', () => {
    expect(envFileText({ A: 'one', B: ' two = 2 ', C: '' })).toBe('A=one\nB= two = 2 \nC=\n');
    expect(() => envFileText({ 'BAD NAME': 'x' })).toThrow("BAD NAME can't be given to the container as it is.");
  });
});

describe('the secret box', () => {
  const place = { companyId: COMPANY_A, environmentId: 'env-1', name: 'DATABASE_URL' };
  const box = SecretBox.fromKeyText(SecretBox.generateKeyText());

  it('seals a secret so only this key, in this place, opens it', () => {
    const sealed = box.seal('postgres://app:fake-dummy-secret@db/app', place);

    expect(sealed.ciphertext.toString('utf8')).not.toContain('fake-dummy-secret');
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.tag).toHaveLength(16);
    expect(sealed.keyId).toBe(box.keyId);
    expect(box.open(sealed, place)).toBe('postgres://app:fake-dummy-secret@db/app');
  });

  it('uses a new nonce every time, so equal secrets don’t look equal', () => {
    const first = box.seal('same', place);
    const second = box.seal('same', place);

    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it('refuses a secret moved to another place, changed, or sealed with another key', () => {
    const sealed = box.seal('value', place);

    for (const elsewhere of [
      { ...place, name: 'OTHER' },
      { ...place, environmentId: 'env-2' },
      { ...place, companyId: '00000000-0000-4000-8000-00000000000b' },
    ]) {
      expect(() => box.open(sealed, elsewhere)).toThrow(SecretUnreadableError);
    }
    const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext).fill(0) };
    expect(() => box.open(tampered, place)).toThrow("DATABASE_URL can't be read: it was changed outside DreamDevOps. Set it again.");
    const other = SecretBox.fromKeyText(SecretBox.generateKeyText());
    expect(() => other.open(sealed, place)).toThrow("DATABASE_URL was sealed with another key than this server's. Set it again.");
  });

  it('needs a key of 32 bytes, in base64', () => {
    expect(() => SecretBox.fromKeyText('short')).toThrow('The secrets key must be 32 bytes, written in base64.');
    expect(() => SecretBox.fromKeyText(Buffer.alloc(16).toString('base64'))).toThrow('32 bytes');
  });
});

describe('the secrets key file', () => {
  it('is created on a developer machine, and reused', () => {
    const path = join(temporary(), 'nested', 'environment-secrets.key');

    const created = loadSecretsKey(path, { createIfMissing: true });

    expect(loadSecretsKey(path, { createIfMissing: true }).keyId).toBe(created.keyId);
    expect(Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')).toHaveLength(32);
  });

  // Windows has no Unix permissions, and the folder's access list decides who can read it.
  it.skipIf(process.platform === 'win32')('is readable only by its owner', () => {
    const path = join(temporary(), 'environment-secrets.key');

    loadSecretsKey(path, { createIfMissing: true });

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('must already exist elsewhere, and be valid', () => {
    expect(() => loadSecretsKey(join(temporary(), 'missing.key'), { createIfMissing: false })).toThrow(
      /doesn't exist\. Set SECRETS_KEY_FILE/,
    );
    const broken = join(temporary(), 'broken.key');
    writeFileSync(broken, 'not a key');
    expect(() => loadSecretsKey(broken, { createIfMissing: false })).toThrow('32 bytes');
  });
});

describe('variable notifications', () => {
  it('name the variable, never its value', () => {
    const event = createDomainEvent({
      eventType: 'EnvironmentVariableSet',
      companyId: parseCompanyId(COMPANY_A),
      payload: {
        environmentName: 'Production',
        applicationName: 'Billing',
        production: true,
        name: 'DATABASE_URL',
        secret: true,
        change: 'changed',
        reason: 'Rotating the database password.',
      },
    });

    expect(summarize(event, 'Acme')).toBe(
      'Acme: The secret DATABASE_URL of the production environment "Production" of "Billing" was changed: "Rotating the database password.".',
    );
  });
});

describe('variable routes', () => {
  let app: INestApplication;
  const ENVIRONMENT = '00000000-0000-4000-8000-0000000000bb';
  const VARIABLE = '00000000-0000-4000-8000-0000000000dd';

  beforeAll(async () => {
    app = await createTestApp({ config: { secureCookies: false } });
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['get', `/api/v1/company/environments/${ENVIRONMENT}/variables`],
    ['post', `/api/v1/company/environments/${ENVIRONMENT}/variables`],
    ['patch', `/api/v1/company/variables/${VARIABLE}`],
    ['delete', `/api/v1/company/variables/${VARIABLE}`],
  ] as const)('ask anonymous users to sign in: %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](path).expect(401);
  });

  it('let only people who manage environments change them', async () => {
    // This sample member has none of the environment permissions.
    const member = await signIn(app, 'developer-a');

    await member.post(`/api/v1/company/environments/${ENVIRONMENT}/variables`).send({}).expect(403);
    await member.patch(`/api/v1/company/variables/${VARIABLE}`).send({}).expect(403);
    await member.delete(`/api/v1/company/variables/${VARIABLE}`).send({}).expect(403);
  });
});
