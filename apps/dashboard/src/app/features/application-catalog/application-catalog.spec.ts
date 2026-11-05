import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl } from '@angular/forms';
import { provideRouter } from '@angular/router';
import { APPLICATION_TYPES, settle } from '../../testing';
import { ApplicationCatalogApi, type ApplicationType, groupByLayer, orderedCommands } from './application-catalog.api';
import { ApplicationTypePicker } from './application-type-picker';
import { ApplicationTypes } from './application-types';

/** A type in a language and a layer the dashboard has never seen, as a future catalog might hold. */
const GO_WORKER: ApplicationType = {
  key: 'go-worker',
  name: 'Go worker',
  description: 'Runs background jobs.',
  layer: { key: 'worker', name: 'Worker', description: 'Work that happens out of sight.' },
  language: { key: 'go', name: 'Go', runtime: { name: 'Go', version: '1.25', image: 'golang:1.25-alpine' } },
  frameworks: ['River'],
  serving: { kind: 'process', port: 8080, healthCheckPath: '/health' },
  commands: { start: './worker', schedule: './worker schedule', install: 'go mod download', test: 'go test ./...' },
  scaffolds: [{ key: 'river', name: 'River', description: 'Jobs with River.', includes: ['A first job'] }],
};

@Component({
  imports: [ApplicationTypePicker],
  template: `<app-application-type-picker [types]="types()" [control]="control" />`,
})
class PickerHost {
  readonly types = signal<readonly ApplicationType[]>(APPLICATION_TYPES);
  readonly control = new FormControl('', { nonNullable: true });
}

describe('application catalog', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const element = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
  const render = async (fixture: ComponentFixture<unknown>) => {
    await settle();
    await fixture.whenStable();
  };

  describe('ApplicationCatalogApi', () => {
    it('asks for the catalog once', async () => {
      const api = TestBed.inject(ApplicationCatalogApi);

      const first = api.types();
      http.expectOne('/api/v1/application-types').flush(APPLICATION_TYPES);

      await expect(first).resolves.toHaveLength(4);
      await expect(api.types()).resolves.toHaveLength(4);
      http.expectNone('/api/v1/application-types');
    });

    it('asks again after a failure', async () => {
      const api = TestBed.inject(ApplicationCatalogApi);

      const failed = api.types();
      http.expectOne('/api/v1/application-types').flush({}, { status: 503, statusText: 'Unavailable' });
      await expect(failed).rejects.toBeDefined();

      const retried = api.types();
      http.expectOne('/api/v1/application-types').flush(APPLICATION_TYPES);
      await expect(retried).resolves.toHaveLength(4);
    });
  });

  describe('helpers', () => {
    it('group types by layer in the order the catalog gives', () => {
      const groups = groupByLayer([...APPLICATION_TYPES, GO_WORKER]);

      expect(groups.map((group) => [group.layer.name, group.types.map((type) => type.key)])).toEqual([
        ['Frontend', ['python-frontend', 'typescript-frontend']],
        ['Backend', ['python-backend', 'typescript-backend']],
        ['Worker', ['go-worker']],
      ]);
    });

    it('list commands in the order they run, with new ones last', () => {
      expect(orderedCommands(GO_WORKER).map((step) => step.name)).toEqual(['install', 'test', 'start', 'schedule']);
    });
  });

  describe('ApplicationTypes page', () => {
    const open = async (types: ApplicationType[]) => {
      const fixture = TestBed.createComponent(ApplicationTypes);
      fixture.detectChanges();
      http.expectOne('/api/v1/application-types').flush(types);
      await render(fixture);
      return fixture;
    };

    it('explains what each type needs from a repository', async () => {
      const fixture = await open(APPLICATION_TYPES);

      const headings = [...element(fixture).querySelectorAll('h2, h3')].map((heading) => heading.textContent?.trim());
      expect(headings).toEqual([
        'Frontend',
        'Python frontend python-frontend',
        'TypeScript frontend typescript-frontend',
        'Backend',
        'Python backend python-backend',
        'TypeScript backend typescript-backend',
      ]);
      const backend = element(fixture).querySelector('[aria-labelledby="heading-typescript-backend"]')!;
      expect(backend.textContent).toContain('Node.js 24, built on node:24-alpine');
      expect(backend.textContent).toContain('A process on port 3000, checked at /health');
      const steps = [...backend.querySelectorAll('tbody tr')].map((row) =>
        [...row.querySelectorAll('td')].map((cell) => cell.textContent?.trim()).join(' '),
      );
      expect(steps).toEqual([
        'install npm ci',
        'lint npm run lint',
        'test npm test',
        'build npm run build',
        'migrate npm run migrate',
        'start npm start',
      ]);
      const frontend = element(fixture).querySelector('[aria-labelledby="heading-typescript-frontend"]')!;
      expect(frontend.textContent).toContain('Static files built into dist/');
    });

    it('shows a type, a language and a layer it has never seen, with no change', async () => {
      const fixture = await open([...APPLICATION_TYPES, GO_WORKER]);

      const worker = element(fixture).querySelector('[aria-labelledby="heading-go-worker"]')!;
      expect(element(fixture).textContent).toContain('Worker');
      expect(worker.textContent).toContain('Go 1.25, built on golang:1.25-alpine');
      expect(worker.textContent).toContain('schedule');
      expect(worker.textContent).toContain('River: Jobs with River.');
    });

    it('lists the scaffolds each type can start from, and what they include', async () => {
      const fixture = await open(APPLICATION_TYPES);

      const frontend = element(fixture).querySelector('[aria-labelledby="heading-typescript-frontend"]')!;
      const scaffolds = [...frontend.querySelectorAll('.scaffold-list li')].map((item) => item.textContent?.trim());
      expect(scaffolds).toEqual([
        'Angular: An Angular app with standalone components, signals and routing. Includes: Tests · Linting',
        'React: A React app built with Vite. Includes: Tests · Linting',
      ]);
    });

    it('shows why the catalog could not load', async () => {
      const fixture = TestBed.createComponent(ApplicationTypes);
      fixture.detectChanges();
      http.expectOne('/api/v1/application-types').flush({ title: 'Try again shortly.' }, { status: 503, statusText: 'No' });
      await render(fixture);

      expect(element(fixture).querySelector('[role="alert"]')?.textContent).toContain('Try again shortly.');
    });
  });

  describe('ApplicationTypePicker', () => {
    it('sets the chosen type, and offers new types with no change', async () => {
      const fixture = TestBed.createComponent(PickerHost);
      fixture.detectChanges();
      await render(fixture);

      const radios = [...element(fixture).querySelectorAll<HTMLInputElement>('input[type="radio"]')];
      expect(radios.map((radio) => radio.value)).toEqual([
        'python-frontend',
        'typescript-frontend',
        'python-backend',
        'typescript-backend',
      ]);
      radios[3]!.click();
      expect(fixture.componentInstance.control.value).toBe('typescript-backend');

      fixture.componentInstance.types.set([...APPLICATION_TYPES, GO_WORKER]);
      await render(fixture);
      expect(element(fixture).querySelector('[aria-label="Worker"]')?.textContent).toContain('Go worker');
    });

    it('groups its choices, so the keyboard moves between them', async () => {
      const fixture = TestBed.createComponent(PickerHost);
      fixture.detectChanges();
      await render(fixture);

      const names = [...element(fixture).querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((radio) => radio.name);
      expect(new Set(names)).toEqual(new Set(['application-type']));
    });

    it('names each choice with its type, for screen readers', async () => {
      const fixture = TestBed.createComponent(PickerHost);
      fixture.detectChanges();
      await render(fixture);

      const option = element(fixture).querySelector<HTMLInputElement>('input[value="python-backend"]')!;
      expect(option.closest('label')?.textContent).toContain('Python backend');
      expect(element(fixture).querySelector(`#${option.getAttribute('aria-describedby')}`)?.textContent).toContain(
        'Python 3.13 · FastAPI, Django, Flask',
      );
    });
  });
});
