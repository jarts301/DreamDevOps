import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describeEvent } from '../../core/events';
import { settle } from '../../testing';
import { CompanyEdition } from './company-edition';
import { PlatformEditions } from './platform-editions';

const FEATURES = [
  { key: 'audit-history', name: 'Tamper-evident audit history', edition: 'community', enabled: true },
  { key: 'audit-export', name: 'Audit export', edition: 'commercial', enabled: false },
];

const COMPANIES = [
  { companyId: 'c-1', companyName: 'Acme', edition: 'community', changedAt: null },
  { companyId: 'c-2', companyName: 'Globex', edition: 'commercial', changedAt: '2026-11-01T10:00:00Z' },
];

describe('editions', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const text = (fixture: ComponentFixture<unknown>) => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const render = async (fixture: ComponentFixture<unknown>) => {
    await settle();
    await fixture.whenStable();
  };

  it('describes an edition change', () => {
    expect(describeEvent('CompanyEditionChanged', { edition: 'commercial', previousEdition: 'community' })).toBe(
      'Moved the company from the Community to the Commercial Edition',
    );
  });

  describe('CompanyEdition', () => {
    const open = async (body: object) => {
      const fixture = TestBed.createComponent(CompanyEdition);
      fixture.detectChanges();
      await settle();
      http.expectOne('/api/v1/company/entitlements').flush(body);
      await render(fixture);
      return fixture;
    };

    it('separates included features from the rest', async () => {
      const fixture = await open({ edition: 'community', features: FEATURES });
      const sections = [...(fixture.nativeElement as HTMLElement).querySelectorAll('section')];

      expect(text(fixture)).toContain('Your company uses the Community Edition.');
      expect(sections[0]!.textContent).toContain('Tamper-evident audit history');
      expect(sections[0]!.textContent).not.toContain('Audit export');
      expect(sections[1]!.textContent).toContain('Audit export');
      expect(sections[1]!.textContent).toContain('These need the Commercial Edition.');
    });

    it("explains features a Commercial company's license leaves out", async () => {
      const fixture = await open({ edition: 'commercial', features: FEATURES });

      expect(text(fixture)).toContain("Your company's license doesn't include these.");
    });

    it('leaves out the second section when everything is included', async () => {
      const fixture = await open({ edition: 'commercial', features: [{ ...FEATURES[1], enabled: true }] });

      expect(text(fixture)).not.toContain('Not included');
    });
  });

  describe('PlatformEditions', () => {
    const open = async (commercialAvailable: boolean) => {
      const fixture = TestBed.createComponent(PlatformEditions);
      fixture.detectChanges();
      await settle();
      http.expectOne('/api/v1/platform/editions').flush({
        provider: { name: 'Test license', commercialAvailable, detail: 'Valid until 2027' },
        companies: COMPANIES,
      });
      await render(fixture);
      return fixture;
    };
    const select = (fixture: ComponentFixture<unknown>, name: string) =>
      (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>(`select[aria-label="Edition of ${name}"]`)!;

    it("can't change editions when only the Community Edition is installed", async () => {
      const fixture = await open(false);

      expect(text(fixture)).toContain('Only the Community Edition is installed');
      expect(select(fixture, 'Acme').disabled).toBe(true);
    });

    it('shows each company’s edition and when it last changed', async () => {
      const fixture = await open(true);

      expect(text(fixture)).toContain('Commercial features are installed: Test license.');
      expect(select(fixture, 'Acme').value).toBe('community');
      expect(select(fixture, 'Globex').value).toBe('commercial');
      expect(text(fixture)).toContain('Never');
    });

    it('saves a new edition and confirms it', async () => {
      const fixture = await open(true);
      const acme = select(fixture, 'Acme');

      acme.value = 'commercial';
      acme.dispatchEvent(new Event('change'));
      const request = http.expectOne('/api/v1/platform/editions/c-1');
      expect(request.request.method).toBe('PUT');
      expect(request.request.body).toEqual({ edition: 'commercial' });
      request.flush(null);
      await settle();
      http.expectOne('/api/v1/platform/editions').flush({
        provider: { name: 'Test license', commercialAvailable: true, detail: null },
        companies: [{ ...COMPANIES[0], edition: 'commercial' }, COMPANIES[1]],
      });
      await render(fixture);

      expect(text(fixture)).toContain('Acme now uses the Commercial Edition.');
    });

    it('shows a refusal and the saved edition again', async () => {
      const fixture = await open(true);
      const acme = select(fixture, 'Acme');

      acme.value = 'commercial';
      acme.dispatchEvent(new Event('change'));
      http
        .expectOne('/api/v1/platform/editions/c-1')
        .flush(
          { status: 409, detail: 'The Commercial Edition is not installed on this server.' },
          { status: 409, statusText: 'Conflict' },
        );
      await settle();
      http.expectOne('/api/v1/platform/editions').flush({
        provider: { name: 'Community', commercialAvailable: false, detail: null },
        companies: COMPANIES,
      });
      await render(fixture);

      expect(text(fixture)).toContain('The Commercial Edition is not installed on this server.');
      expect(select(fixture, 'Acme').value).toBe('community');
    });
  });
});
