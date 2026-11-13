import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { APP_NAME } from './app-info';
import { RuntimeConfig } from './runtime-config';

describe('App', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  });

  it('shows the application name and the API address from the runtime settings', async () => {
    const loading = TestBed.inject(RuntimeConfig).load();
    TestBed.inject(HttpTestingController).expectOne('/config.json').flush({ apiUrl: 'https://api.example.com' });
    await loading;

    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('h1')?.textContent).toBe(APP_NAME);
    expect(element.textContent).toContain('https://api.example.com');
  });
});
