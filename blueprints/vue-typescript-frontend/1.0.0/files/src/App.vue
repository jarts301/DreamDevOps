<script setup lang="ts">
import { ref } from 'vue';
import { APP_NAME } from './app-info';
import { type Check, checkApi } from './check-api';
import type { Settings } from './runtime-config';

const props = defineProps<{ settings: Settings }>();
const checking = ref(false);
const check = ref<Check | null>(null);

async function onCheck(): Promise<void> {
  checking.value = true;
  check.value = await checkApi(props.settings.apiUrl);
  checking.value = false;
}
</script>

<template>
  <main>
    <h1>{{ APP_NAME }}</h1>
    <p>Your web frontend is running.</p>
    <p>
      It calls its API at <code>{{ props.settings.apiUrl }}</code>.
    </p>
    <section aria-labelledby="check-heading">
      <h2 id="check-heading">Check the API</h2>
      <p>Pings the API, and starts a trace you can follow in DreamDevOps, under Monitoring.</p>
      <button type="button" :disabled="checking" @click="onCheck">Check the API</button>
      <p v-if="check" role="status">
        {{ check.message }} Trace ID: <code>{{ check.traceId }}</code>
      </p>
    </section>
  </main>
</template>
