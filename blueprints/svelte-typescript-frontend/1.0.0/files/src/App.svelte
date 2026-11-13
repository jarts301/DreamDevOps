<script lang="ts">
  import { APP_NAME } from './app-info';
  import { type Check, checkApi } from './check-api';
  import type { Settings } from './runtime-config';

  let { settings }: { settings: Settings } = $props();
  let checking = $state(false);
  let check = $state<Check | null>(null);

  async function onCheck(): Promise<void> {
    checking = true;
    check = await checkApi(settings.apiUrl);
    checking = false;
  }
</script>

<main>
  <h1>{APP_NAME}</h1>
  <p>Your web frontend is running.</p>
  <p>
    It calls its API at <code>{settings.apiUrl}</code>.
  </p>
  <section aria-labelledby="check-heading">
    <h2 id="check-heading">Check the API</h2>
    <p>Pings the API, and starts a trace you can follow in DreamDevOps, under Monitoring.</p>
    <button type="button" disabled={checking} onclick={onCheck}>Check the API</button>
    {#if check}
      <p role="status">
        {check.message} Trace ID: <code>{check.traceId}</code>
      </p>
    {/if}
  </section>
</main>
