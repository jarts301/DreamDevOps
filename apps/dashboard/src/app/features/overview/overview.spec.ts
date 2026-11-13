import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { type CurrentUser, SessionService } from '../../core/session.service';
import { sampleUser } from '../../testing';
import { NotAllowed, NotFound } from '../messages/messages';
import { Overview } from './overview';

describe('Overview', () => {
  const render = (user: CurrentUser) => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SessionService,
          useValue: {
            user: () => user,
            isPlatformUser: () => user.permissions.includes('companies:manage'),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(Overview);
    fixture.detectChanges();
    return (fixture.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ') ?? '';
  };

  it('greets a member with their company, role and what they can do', () => {
    const text = render(sampleUser({ role: 'developer', permissions: ['code:push', 'feature-images:build'] }));

    expect(text).toContain('Welcome, Sample Person');
    expect(text).toContain("You're working in Acme. Your role is Developer.");
    expect(text).toContain('Push code and open pull requests');
    expect(text).toContain('Build feature test images');
  });

  it('tells a platform admin they can start companies but not see their data', () => {
    const text = render(
      sampleUser({ companyId: null, companyName: null, role: null, memberships: [], permissions: ['companies:manage'] }),
    );

    expect(text).toContain("You're a Platform Admin. You can start companies, but you can't see their data.");
  });

  it('tells someone with no company how to join one', () => {
    const text = render(sampleUser({ companyId: null, companyName: null, role: null, memberships: [], permissions: [] }));

    expect(text).toContain("You're not in a company yet");
    expect(text).not.toContain('What you can do');
  });
});

describe('messages', () => {
  it('explain missing access and missing pages, with a way back', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    for (const [component, heading] of [
      [NotAllowed, "You don't have access to this page"],
      [NotFound, "This page doesn't exist"],
    ] as const) {
      const fixture = TestBed.createComponent(component);
      fixture.detectChanges();
      const element = fixture.nativeElement as HTMLElement;
      expect(element.querySelector('h1')?.textContent).toBe(heading);
      expect(element.querySelector('a')?.getAttribute('href')).toBe('/');
    }
  });
});
