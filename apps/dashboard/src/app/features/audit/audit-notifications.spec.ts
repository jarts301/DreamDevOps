import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describeEvent } from '../../core/events';
import { settle } from '../../testing';
import { Notifications } from '../notifications/notifications';
import { AuditLog } from './audit-log';
import { MyActivity } from './my-activity';

const entry = (sequence: number, eventType: string, payload: object, actor: object | null = null) => ({
  sequence,
  eventType,
  actor,
  occurredAt: '2026-11-01T10:00:00Z',
  payload,
});

describe('audit and notification screens', () => {
  let http: HttpTestingController;

  beforeEach(() => {
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

  describe('describeEvent', () => {
    it('reads like a sentence, with role names', () => {
      expect(describeEvent('RoleGranted', { role: 'tech-lead', invitationId: 'i' })).toBe('Joined as Tech Lead');
      expect(describeEvent('RoleGranted', { role: 'viewer' })).toBe("Changed a member's role to Viewer");
      expect(describeEvent('CompanyRenamed', { previousName: 'Old', name: 'New' })).toBe(
        'Renamed the company from "Old" to "New"',
      );
      expect(describeEvent('SomethingNew', {})).toBe('SomethingNew');
    });
  });

  describe('AuditLog', () => {
    const open = async (page: object) => {
      const fixture = TestBed.createComponent(AuditLog);
      fixture.detectChanges();
      await settle();
      http.expectOne('/api/v1/company/audit').flush(page);
      await render(fixture);
      return fixture;
    };

    it('shows who did what, and the platform for its own work', async () => {
      const fixture = await open({
        entries: [
          entry(2, 'RoleGranted', { role: 'developer' }, { userId: 'u', displayName: 'Ana Admin' }),
          entry(1, 'CompanyProvisioned', {}),
        ],
        nextBefore: null,
      });

      expect(text(fixture)).toContain('Ana Admin');
      expect(text(fixture)).toContain("Changed a member's role to Developer");
      expect(text(fixture)).toContain('DreamDevOps');
      expect(button(fixture, 'Show older entries')).toBeUndefined();
    });

    it('loads older entries on request', async () => {
      const fixture = await open({ entries: [entry(51, 'MemberRemoved', {})], nextBefore: '2026-11-01T10:00:00.000Z|51' });

      button(fixture, 'Show older entries').click();
      await settle();
      const request = http.expectOne((candidate) => candidate.url === '/api/v1/company/audit');
      expect(request.request.params.get('before')).toBe('2026-11-01T10:00:00.000Z|51');
      request.flush({ entries: [entry(50, 'InvitationRevoked', {})], nextBefore: null });
      await render(fixture);

      expect(text(fixture)).toContain('Revoked an invitation');
    });

    it('reports an intact log and a tampered one', async () => {
      const fixture = await open({ entries: [], nextBefore: null });

      button(fixture, 'Check integrity').click();
      http.expectOne('/api/v1/company/audit/verify').flush({ valid: true, checked: 12, brokenAtSequence: null, reason: null });
      await render(fixture);
      expect(text(fixture)).toContain('The log is intact. 12 entries checked.');

      button(fixture, 'Check integrity').click();
      http
        .expectOne('/api/v1/company/audit/verify')
        .flush({ valid: false, checked: 3, brokenAtSequence: 4, reason: 'This entry was changed after it was recorded.' });
      await render(fixture);
      expect(text(fixture)).toContain('tampered with at entry 4');
    });
  });

  describe('MyActivity', () => {
    it('lists actions with their company', async () => {
      const fixture = TestBed.createComponent(MyActivity);
      fixture.detectChanges();
      await settle();
      http.expectOne('/api/v1/platform/audit').flush({
        entries: [
          { companyId: 'c', companyName: 'Acme', eventType: 'CompanySuspended', occurredAt: '2026-11-01T10:00:00Z', payload: {} },
        ],
        nextBefore: null,
      });
      await render(fixture);

      expect(text(fixture)).toContain('Acme');
      expect(text(fixture)).toContain('Suspended the company');
    });
  });

  describe('Notifications', () => {
    const RULE = {
      id: 'r-1',
      name: 'Team chat',
      kind: 'slack',
      destination: 'https://hooks.slack.com',
      eventTypes: ['MemberRemoved'],
      enabled: true,
      lastDeliveryAt: null,
      lastError: 'The webhook answered with status 404.',
    };

    const open = async (rules: object[] = [RULE]) => {
      const fixture = TestBed.createComponent(Notifications);
      fixture.detectChanges();
      await settle();
      http.expectOne('/api/v1/company/notification-rules/event-types').flush([
        { type: 'MemberRemoved', description: 'A member is removed' },
        { type: 'UserInvited', description: 'Someone is invited to the company' },
      ]);
      await settle();
      http.expectOne('/api/v1/company/notification-rules').flush(rules);
      await render(fixture);
      return fixture;
    };

    it('shows rules with only their destination, and any failure', async () => {
      const fixture = await open();

      expect(text(fixture)).toContain('https://hooks.slack.com');
      expect(text(fixture)).toContain('Failed: The webhook answered with status 404.');
    });

    it('creates a rule with the chosen events', async () => {
      const fixture = await open([]);
      const element = fixture.nativeElement as HTMLElement;
      const set = async (selector: string, value: string) => {
        const input = element.querySelector<HTMLInputElement>(selector)!;
        input.value = value;
        input.dispatchEvent(new Event('input'));
        await render(fixture);
      };
      await set('input[formcontrolname="name"]', 'Alerts');
      await set('input[formcontrolname="url"]', 'https://hooks.example.com/abc');
      expect(button(fixture, 'Create rule').disabled).toBe(true);
      element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click();
      await render(fixture);

      button(fixture, 'Create rule').click();
      const request = http.expectOne((candidate) => candidate.method === 'POST');
      expect(request.request.body).toEqual({
        name: 'Alerts',
        kind: 'slack',
        url: 'https://hooks.example.com/abc',
        eventTypes: ['UserInvited'],
      });
      request.flush({});
      await settle();
      http.expectOne('/api/v1/company/notification-rules').flush([RULE]);
      await render(fixture);

      expect(text(fixture)).toContain('Rule created.');
    });

    it('reports the result of a test message', async () => {
      const fixture = await open();

      button(fixture, 'Send a test from Team chat').click();
      http
        .expectOne('/api/v1/company/notification-rules/r-1/test')
        .flush({ delivered: false, error: 'The webhook answered with status 404.' });
      await settle();
      http.expectOne('/api/v1/company/notification-rules').flush([RULE]);
      await render(fixture);

      expect(text(fixture)).toContain('The test message failed');
    });

    it('asks for confirmation before deleting', async () => {
      const fixture = await open();

      button(fixture, 'Delete Team chat').click();
      await render(fixture);
      http.expectNone((candidate) => candidate.method === 'DELETE');
      button(fixture, 'Confirm deletion').click();
      http.expectOne((candidate) => candidate.method === 'DELETE').flush(null);
      await settle();
      http.expectOne('/api/v1/company/notification-rules').flush([]);
      await render(fixture);

      expect(text(fixture)).toContain('No rules yet.');
    });
  });
});
