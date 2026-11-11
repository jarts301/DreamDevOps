import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { App } from './app';
import { APP_NAME } from './app-info';
import { RuntimeConfig } from './runtime-config';
import { newTraceparent, traceContextInterceptor, traceIdOf } from './trace-context';

const TRACEPARENT = /^00-([0-9a-f]{32})-[0-9a-f]{16}-01$/;

describe('App', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([traceContextInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    const loading = TestBed.inject(RuntimeConfig).load();
    http.expectOne('/config.json').flush({ apiUrl: 'https://api.example.com/' });
    await loading;
  });

  afterEach(() => http.verify());

  const open = async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    return { fixture, element: fixture.nativeElement as HTMLElement };
  };

  it('shows the application name and the API address from the runtime settings', async () => {
    const { element } = await open();

    expect(element.querySelector('h1')?.textContent).toBe(APP_NAME);
    expect(element.textContent).toContain('https://api.example.com/');
  });

  it('pings the API with a new trace, and shows its ID so its logs and trace can be found', async () => {
    const { fixture, element } = await open();

    element.querySelector('button')!.click();
    const ping = http.expectOne('https://api.example.com/ping');
    const traceparent = ping.request.headers.get('traceparent')!;
    expect(traceparent).toMatch(TRACEPARENT);
    ping.flush({ status: 'ok', time: '2026-11-10T12:00:00.000Z' });
    await fixture.whenStable();

    expect(element.querySelector('[role="status"]')?.textContent).toContain('The API answered.');
    expect(element.querySelector('[role="status"] code')?.textContent).toBe(traceIdOf(traceparent));
  });

  it('says when the API doesn’t answer', async () => {
    const { fixture, element } = await open();

    element.querySelector('button')!.click();
    http.expectOne('https://api.example.com/ping').flush(null, { status: 503, statusText: 'Service Unavailable' });
    await fixture.whenStable();

    expect(element.querySelector('[role="status"]')?.textContent).toContain("The API didn't answer (HTTP 503).");
  });
});

describe('trace context', () => {
  let http: HttpTestingController;
  let client: HttpClient;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([traceContextInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    client = TestBed.inject(HttpClient);
  });

  afterEach(() => http.verify());

  it('starts a new trace for each call to the API, and for no other call', async () => {
    // The API is at /api until the runtime settings say otherwise.
    void firstValueFrom(client.get('/api/orders'));
    void firstValueFrom(client.get('/api/orders'));
    void firstValueFrom(client.get('/apiary'));
    void firstValueFrom(client.get('https://fonts.example.com/font.woff2'));

    const [first, second] = http.match('/api/orders');
    expect(first!.request.headers.get('traceparent')).toMatch(TRACEPARENT);
    expect(traceIdOf(first!.request.headers.get('traceparent')!)).not.toBe(traceIdOf(second!.request.headers.get('traceparent')!));
    expect(http.expectOne('/apiary').request.headers.has('traceparent')).toBe(false);
    expect(http.expectOne('https://fonts.example.com/font.woff2').request.headers.has('traceparent')).toBe(false);
    [first, second].forEach((request) => request!.flush({}));
  });

  it('keeps a trace a call already has', async () => {
    void firstValueFrom(client.get('/api/orders', { headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' } }));

    expect(http.expectOne('/api/orders').request.headers.get('traceparent')).toBe(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    );
  });

  it('makes W3C traceparent headers from random bytes', () => {
    const counting = (bytes: Uint8Array<ArrayBuffer>) => bytes.map((_, index) => index + 1);

    expect(newTraceparent(counting)).toBe('00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01');
    expect(traceIdOf('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });
});
