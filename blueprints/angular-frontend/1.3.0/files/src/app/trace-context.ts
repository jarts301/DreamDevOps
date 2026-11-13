import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { RuntimeConfig } from './runtime-config';

/** Fills bytes with random values. Tests pass their own. */
export type RandomBytes = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;

const secureRandom: RandomBytes = (bytes) => crypto.getRandomValues(bytes);

/**
 * A W3C traceparent header that starts a new trace, such as
 * 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01. The API continues it, and so
 * do the services it calls, so one click is one trace across all of them.
 */
export function newTraceparent(random: RandomBytes = secureRandom): string {
  const hex = (length: number) => [...random(new Uint8Array(length))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `00-${hex(16)}-${hex(8)}-01`;
}

/** The trace ID in a traceparent header, which is how the trace is found. */
export function traceIdOf(traceparent: string): string {
  return traceparent.split('-')[1] ?? '';
}

/**
 * Starts a trace for each call to the app's own API, unless the call has one already.
 * Calls anywhere else, such as for /config.json, don't get one, so no trace leaks to
 * other sites.
 */
export const traceContextInterceptor: HttpInterceptorFn = (request, next) => {
  const api = inject(RuntimeConfig).settings().apiUrl.replace(/\/$/, '');
  const toApi = request.url === api || request.url.startsWith(`${api}/`);
  if (!toApi || request.headers.has('traceparent')) {
    return next(request);
  }
  return next(request.clone({ setHeaders: { traceparent: newTraceparent() } }));
};
