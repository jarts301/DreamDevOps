// Publishes the agent's image and Helm chart to the local Forgejo, as the bot, so the
// dashboard's connect command works against the local target. Needs the stack with the
// target profile: docker compose --profile target up -d
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NEWLINE = '\n';
const HELM_IMAGE ='alpine/helm:3.22.1@sha256:8191701ad1f82ee3695c87211fcbfe6d7b1bb7df92ac1c8de9ccdb0995a6a2c1';
const agentDir = fileURLToPath(new URL('..', import.meta.url));
const chartDir = fileURLToPath(new URL('../../../charts/dreamdevops-agent', import.meta.url));
const { version } = JSON.parse(readFileSync(join(agentDir, 'package.json'), 'utf8')) as { version: string };

const bot = process.env.FORGEJO_BOT_USERNAME ?? 'dreamdevops-bot';
const password = process.env.FORGEJO_BOT_PASSWORD;
if (password === undefined) {
  throw new Error('FORGEJO_BOT_PASSWORD is not set. See infra/local/README.md.');
}
const forgejoPort = process.env.FORGEJO_HTTP_PORT ?? '3000';
// The host pushes the image to localhost; the target pulls it through its gateway.
const pushImage = `localhost:${forgejoPort}/${bot}/dreamdevops-agent:${version}`;
const targetRepository = `platform.internal:3000/${bot}/dreamdevops-agent`;

const run = (command: string, args: string[], input?: string) =>
  execFileSync(command, args, {
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    input,
    env: { ...process.env, BOT_PASSWORD: password },
  });

console.log(`Building the agent image ${version}.`);
// One plain image, without attestations, so every container runtime reads it the same way.
run('docker', ['build', '--provenance=false', '--sbom=false', '--platform', 'linux/amd64', '-t', pushImage, agentDir]);
run('docker', ['login', `localhost:${forgejoPort}`, '--username', bot, '--password-stdin'], password);
run('docker', ['push', pushImage]);

// The chart is packaged in a copy, with the image's address set.
const work = mkdtempSync(join(tmpdir(), 'dreamdevops-chart-'));
try {
  cpSync(chartDir, join(work, 'dreamdevops-agent'), { recursive: true });
  const valuesPath = join(work, 'dreamdevops-agent', 'values.yaml');
  writeFileSync(
    valuesPath,
    readFileSync(valuesPath, 'utf8').replace('  repository: ""', `  repository: ${JSON.stringify(targetRepository)}`),
  );
  const helm = (script: string) =>
    run('docker', [
      'run', '--rm', '--entrypoint', 'sh',
      '--network', 'dreamdevops-local_target',
      '--add-host', 'platform.internal:10.213.90.10',
      // The password comes from the environment, so it never shows in a command line.
      '-e', `BOT=${bot}`, '-e', 'BOT_PASSWORD',
      '-v', `${work}:/work`,
      HELM_IMAGE, '-c', `set -e
cd /work/dreamdevops-agent
${script}`,
    ]);

  helm(
    [
      'helm dependency update',
      'helm package . --destination /work',
      'echo "$BOT_PASSWORD" | helm registry login platform.internal:3000 --username "$BOT" --password-stdin --plain-http',
      // Charts live apart from images, so a chart can't replace the image of the same name.
      `helm push /work/dreamdevops-agent-${version}.tgz oci://platform.internal:3000/$BOT/charts --plain-http`,
    ].join(NEWLINE),
  );
  // Keep the resolved dependency versions, so every package uses the same ones.
  cpSync(join(work, 'dreamdevops-agent', 'Chart.lock'), join(chartDir, 'Chart.lock'));
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`Published the agent ${version}: image ${targetRepository}, chart oci://platform.internal:3000/${bot}/charts/dreamdevops-agent.`);
