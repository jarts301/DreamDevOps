import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { settle } from '../../testing';
import { Companies } from './companies';

const ACTIVE = {
  id: 'c-1',
  name: 'Acme',
  slug: 'acme',
  status: 'active',
  createdAt: '2026-11-01T00:00:00Z',
  provisioningError: null,
};
const FAILED = {
  id: 'c-2',
  name: 'Globex',
  slug: 'globex',
  status: 'provisioning-failed',
  createdAt: '2026-11-02T00:00:00Z',
  provisioningError: 'The Git organization name "globex" is already taken.',
};
const SUSPENDED = { ...ACTIVE, id: 'c-3', name: 'Initech', slug: 'initech', status: 'suspended' };

describe('Companies', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useRealTimers();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const text = (fixture: ComponentFixture<unknown>) => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const button = (fixture: ComponentFixture<unknown>, label: string) =>
    [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
    )!;
  const render = async (fixture: ComponentFixture<unknown>) => {
    await settle();
    await fixture.whenStable();
  };
  const answerList = async (companies: object[]) => {
    await settle();
    http.expectOne('/api/v1/platform/companies').flush(companies);
  };
  const open = async (companies: object[] = [ACTIVE, FAILED, SUSPENDED]) => {
    const fixture = TestBed.createComponent(Companies);
    fixture.detectChanges();
    await answerList(companies);
    await render(fixture);
    return fixture;
  };
  const type = async (fixture: ComponentFixture<unknown>, selector: string, value: string) => {
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render(fixture);
  };

  it('shows each company with a readable status and the reason for a failure', async () => {
    const fixture = await open();

    expect(text(fixture)).toContain('Acme');
    expect(text(fixture)).toContain('Active');
    expect(text(fixture)).toContain('Setup failed');
    expect(text(fixture)).toContain('already taken');
    expect(text(fixture)).toContain('Suspended');
  });

  it('offers only the actions that fit each status', async () => {
    const fixture = await open();

    expect(button(fixture, 'Suspend Acme')).toBeDefined();
    expect(button(fixture, 'Retry setup of Acme')).toBeUndefined();
    expect(button(fixture, 'Retry setup of Globex')).toBeDefined();
    expect(button(fixture, 'Reactivate Initech')).toBeDefined();
    expect(button(fixture, 'Suspend Initech')).toBeUndefined();
  });

  it('creates a company and shows the first admin invitation once', async () => {
    const fixture = await open([]);
    await type(fixture, 'input[formcontrolname="name"]', 'Northwind');
    await type(fixture, 'input[type="email"]', 'founder@example.com');

    button(fixture, 'Create company').click();
    const request = http.expectOne('/api/v1/platform/companies');
    expect(request.request.body).toEqual({ name: 'Northwind', firstAdminEmail: 'founder@example.com' });
    request.flush({
      company: { ...ACTIVE, name: 'Northwind', status: 'active' },
      invitation: { id: 'i-1', token: 'secret-token', expiresAt: '2026-11-11T00:00:00Z' },
    });
    await answerList([{ ...ACTIVE, name: 'Northwind' }]);
    await render(fixture);

    const link = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('[aria-label="Invitation link"]');
    expect(link?.value).toContain('#token=secret-token');
  });

  it('asks for confirmation before suspending', async () => {
    const fixture = await open([ACTIVE]);

    button(fixture, 'Suspend Acme').click();
    await render(fixture);
    http.expectNone('/api/v1/platform/companies/c-1/suspend');
    button(fixture, 'Confirm suspension').click();
    http.expectOne('/api/v1/platform/companies/c-1/suspend').flush(null);
    await answerList([{ ...ACTIVE, status: 'suspended' }]);
    await render(fixture);

    expect(text(fixture)).toContain('Suspended');
  });

  it('renames a company', async () => {
    const fixture = await open([ACTIVE]);
    button(fixture, 'Rename Acme').click();
    await render(fixture);
    await type(fixture, '[aria-label="New name for Acme"]', 'Acme Global');

    button(fixture, 'Save').click();
    const request = http.expectOne('/api/v1/platform/companies/c-1');
    expect(request.request.body).toEqual({ name: 'Acme Global' });
    request.flush(null);
    await answerList([{ ...ACTIVE, name: 'Acme Global' }]);
    await render(fixture);

    expect(text(fixture)).toContain('Acme Global');
  });

  it('shows why the API refused a change', async () => {
    const fixture = await open([ACTIVE]);
    button(fixture, 'Rename Acme').click();
    await render(fixture);
    await type(fixture, '[aria-label="New name for Acme"]', 'Globex');

    button(fixture, 'Save').click();
    http
      .expectOne('/api/v1/platform/companies/c-1')
      .flush({ detail: 'Another company already has this name.' }, { status: 409, statusText: 'Conflict' });
    await render(fixture);

    expect(text(fixture)).toContain('Another company already has this name.');
  });

  it('keeps refreshing while a company is being set up', async () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(Companies);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('/api/v1/platform/companies').flush([{ ...ACTIVE, status: 'provisioning' }]);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(3_000);
    http.expectOne('/api/v1/platform/companies').flush([ACTIVE]);
    await vi.advanceTimersByTimeAsync(10_000);

    http.expectNone('/api/v1/platform/companies');
    fixture.destroy();
    vi.useRealTimers();
  });
});
