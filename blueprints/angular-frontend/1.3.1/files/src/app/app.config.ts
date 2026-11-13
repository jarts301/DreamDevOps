import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { type ApplicationConfig, inject, provideAppInitializer } from '@angular/core';
import { RuntimeConfig } from './runtime-config';
import { traceContextInterceptor } from './trace-context';

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withFetch(), withInterceptors([traceContextInterceptor])),
    provideAppInitializer(() => inject(RuntimeConfig).load()),
  ],
};
