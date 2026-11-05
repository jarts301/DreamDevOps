import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter, TitleStrategy } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import about from '../about.json';
import { App } from './app';
import { routes } from './app.routes';
import { AppTitleStrategy } from './title-strategy';

describe('App', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), { provide: TitleStrategy, useClass: AppTitleStrategy }],
    });
  });

  it('shows the name of the app in its header', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();

    expect((fixture.nativeElement as HTMLElement).querySelector('.brand')?.textContent).toBe(
      about.name,
    );
  });

  it('opens the about page', async () => {
    const harness = await RouterTestingHarness.create();

    await harness.navigateByUrl('/about');

    expect(harness.routeNativeElement?.querySelector('h1')?.textContent).toBe('About');
    expect(TestBed.inject(Title).getTitle()).toBe(`About · ${about.name}`);
  });

  it('sends unknown addresses home', async () => {
    const harness = await RouterTestingHarness.create();

    await harness.navigateByUrl('/nowhere');

    expect(harness.routeNativeElement?.querySelector('button')).not.toBeNull();
  });
});
