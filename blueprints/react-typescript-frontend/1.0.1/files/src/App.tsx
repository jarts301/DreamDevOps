import { useState } from 'react';
import { APP_NAME } from './app-info';
import { type Check, checkApi } from './check-api';
import type { Settings } from './runtime-config';

export function App({ settings }: { readonly settings: Settings }) {
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);

  async function onCheck(): Promise<void> {
    setChecking(true);
    setCheck(await checkApi(settings.apiUrl));
    setChecking(false);
  }

  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p>Your web frontend is running.</p>
      <p>
        It calls its API at <code>{settings.apiUrl}</code>.
      </p>
      <section aria-labelledby="check-heading">
        <h2 id="check-heading">Check the API</h2>
        <p>Pings the API, and starts a trace you can follow in DreamDevOps, under Monitoring.</p>
        <button type="button" disabled={checking} onClick={() => void onCheck()}>
          Check the API
        </button>
        {check && (
          <p role="status">
            {check.message} Trace ID: <code>{check.traceId}</code>
          </p>
        )}
      </section>
    </main>
  );
}
