import { provideHttpClient, withFetch } from '@angular/common/http';
import { type ApplicationConfig, inject, provideAppInitializer } from '@angular/core';
import { RuntimeConfig } from './runtime-config';

export const appConfig: ApplicationConfig = {
  providers: [provideHttpClient(withFetch()), provideAppInitializer(() => inject(RuntimeConfig).load())],
};
