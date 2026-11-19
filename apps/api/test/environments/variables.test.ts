import { describe, expect, it } from 'vitest';
import { ENVIRONMENT_ATTRIBUTE, placeId, withTelemetry } from '@dreamdevops/contracts/environments/telemetry';
import {
  assertWithinLimits,
  MAX_TOTAL_BYTES,
  MAX_VALUES,
  parseVariableName,
  parseVariableValue,
  platformVariables,
} from '../../src/environments/domain/variables.ts';

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
    for (const reserved of ['DREAMDEVOPS_VERSION', 'dreamdevops_anything', 'PATH', 'hostname', 'PORT']) {
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

  it('are limited in number and total size per scope', () => {
    expect(() => assertWithinLimits(Array.from({ length: MAX_VALUES }, () => 10))).not.toThrow();
    expect(() => assertWithinLimits(Array.from({ length: MAX_VALUES + 1 }, () => 1))).toThrow('up to 100 variables and secrets');
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
    applicationId: 'app-1',
    serviceName: 'billing-api',
    metricsEndpoint,
    tracesEndpoint,
  });
  const METRICS = 'http://host.docker.internal:9090/api/v1/otlp/v1/metrics';
  const PLACE = `dreamdevops.environment.id=env-1,dreamdevops.application.id=app-1,dreamdevops.place.id=${placeId('env-1', 'app-1')}`;
  const TRACES = 'http://host.docker.internal:4318/v1/traces';

  it('tell the container where to send its metrics and traces, and which environment and service it is', () => {
    expect(withTelemetry({ LOG_LEVEL: 'debug' }, targets(METRICS, TRACES))).toEqual({
      LOG_LEVEL: 'debug',
      OTEL_SERVICE_NAME: 'billing-api',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: METRICS,
      OTEL_METRIC_EXPORT_INTERVAL: '15000',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: TRACES,
      OTEL_RESOURCE_ATTRIBUTES: PLACE,
    });
    expect(ENVIRONMENT_ATTRIBUTE).toBe('dreamdevops.environment.id');
  });

  it('tell the container only about what the platform keeps', () => {
    expect(withTelemetry({}, targets(METRICS, null))).toEqual({
      OTEL_SERVICE_NAME: 'billing-api',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: METRICS,
      OTEL_METRIC_EXPORT_INTERVAL: '15000',
      OTEL_RESOURCE_ATTRIBUTES: PLACE,
    });
    expect(withTelemetry({}, targets(null, TRACES))).toEqual({
      OTEL_SERVICE_NAME: 'billing-api',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: TRACES,
      OTEL_RESOURCE_ATTRIBUTES: PLACE,
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
      // The last ones count, so the platform's own IDs win.
      OTEL_RESOURCE_ATTRIBUTES: `team=billing,dreamdevops.environment.id=someone-else,${PLACE}`,
    });
  });
});

describe('places', () => {
  it('give one application in one environment the same UUID every time', () => {
    const id = placeId('0b5f8a2c-1d3e-4f5a-8b9c-0d1e2f3a4b5c', '1c6f9b3d-2e4f-4a6b-9c0d-1e2f3a4b5c6d');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(placeId('0B5F8A2C-1D3E-4F5A-8B9C-0D1E2F3A4B5C', '1c6f9b3d-2e4f-4a6b-9c0d-1e2f3a4b5c6d')).toBe(id);
    expect(placeId('1c6f9b3d-2e4f-4a6b-9c0d-1e2f3a4b5c6d', '0b5f8a2c-1d3e-4f5a-8b9c-0d1e2f3a4b5c')).not.toBe(id);
  });
});
