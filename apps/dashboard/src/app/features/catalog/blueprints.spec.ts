import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describeEvent } from '../../core/events';
import { settle } from '../../testing';
import { Blueprints } from './blueprints';

const NODE = {
  key: 'node-service',
  version: '1.1.0',
  applicationType: 'restful-service',
  name: 'Node.js service',
  description: 'A TypeScript HTTP API.',
  language: 'TypeScript',
  framework: 'Fastify on Node.js 24',
  runtime: {
    port: 8080,
    livenessPath: '/health/live',
    readinessPath: '/health/ready',
    resources: { cpu: '250m', memory: '256Mi' },
    configuration: 'Environment variables',
  },
  telemetry: 'OpenTelemetry traces and metrics over OTLP',
  pipeline: '.forgejo/workflows/ci.yaml',
  strategies: ['recreate', 'rolling', 'blue-green', 'canary', 'a-b'],
};

describe('Blueprints', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('shows the newest version of each blueprint, with what it sets up', async () => {
    const fixture = TestBed.createComponent(Blueprints);
    fixture.detectChanges();
    await settle();
    http.expectOne('/api/v1/blueprints').flush([NODE, { ...NODE, version: '1.0.0' }]);
    await settle();
    await fixture.whenStable();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect((fixture.nativeElement as HTMLElement).querySelectorAll('section')).toHaveLength(1);
    expect(text).toContain('Node.js service 1.1.0');
    expect(text).toContain('TypeScript, Fastify on Node.js 24');
    expect(text).toContain('/health/live');
    expect(text).toContain('/health/ready');
    expect(text).toContain('250m CPU, 256Mi memory');
    expect(text).toContain('Recreate, Rolling, Blue/green, Canary, A/B');
    expect(text).toContain('Older versions: 1.0.0');
  });

  it('describes repository events in the audit log', () => {
    expect(describeEvent('RepositoryCreated', { name: 'Billing', repository: 'acme/billing' })).toBe(
      'Created the repository acme/billing for "Billing"',
    );
    expect(describeEvent('RepositoryCreationFailed', { name: 'Billing', reason: 'Name taken' })).toBe(
      'Creating the repository of "Billing" failed: Name taken',
    );
  });
});
