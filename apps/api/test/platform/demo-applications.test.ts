import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BlueprintLibrary } from '../../src/blueprints/infrastructure/blueprint-library.ts';
import { demoApplications } from '../../src/demo/demo-applications.ts';

const BLUEPRINTS = fileURLToPath(new URL('../../../../blueprints', import.meta.url));

describe('the demo applications', () => {
  const library = BlueprintLibrary.load(BLUEPRINTS);
  const types = [
    { key: 'restful-service', name: 'RESTful Service' },
    { key: 'web-frontend', name: 'Web Frontend' },
  ].map((type) => ({ ...type, description: '', blueprint: library.forType(type.key)[0]!, blueprints: library.forType(type.key) }));

  it('are one for each blueprint, named after its framework, language and type', () => {
    const samples = demoApplications(types);

    expect(samples.map((sample) => `${sample.name} (${sample.blueprint})`)).toEqual([
      'cpp-httplib C++ API (httplib-cpp-service)',
      'Express JavaScript API (express-javascript-service)',
      'Fastify JavaScript API (fastify-javascript-service)',
      'FastAPI Python API (fastapi-python-service)',
      'Flask Python API (flask-python-service)',
      'Actix Web Rust API (actix-web-rust-service)',
      'Axum Rust API (axum-rust-service)',
      'Express TypeScript API (express-typescript-service)',
      'NestJS TypeScript API (nestjs-typescript-service)',
      'Fastify TypeScript API (node-service)',
      'React JavaScript Frontend (react-javascript-frontend)',
      'Svelte JavaScript Frontend (svelte-javascript-frontend)',
      'Vue JavaScript Frontend (vue-javascript-frontend)',
      'PyScript Python Frontend (pyscript-frontend)',
      'Angular TypeScript Frontend (angular-frontend)',
      'React TypeScript Frontend (react-typescript-frontend)',
      'Svelte TypeScript Frontend (svelte-typescript-frontend)',
      'Vue TypeScript Frontend (vue-typescript-frontend)',
    ]);
    // Every blueprint is covered once, and no two share a name.
    expect(new Set(samples.map((sample) => sample.blueprint)).size).toBe(library.latest().length);
    expect(new Set(samples.map((sample) => sample.name.toLowerCase())).size).toBe(samples.length);
    const axum = samples.find((sample) => sample.blueprint === 'axum-rust-service')!;
    expect(axum.name).toBe('Axum Rust API');
    expect(axum.description).toBe(
      'A demo RESTful Service, in Rust with Axum 0.8 on Tokio, from the axum-rust-service blueprint. Build it, and deploy it to Test, to try DreamDevOps out.',
    );
  });
});
