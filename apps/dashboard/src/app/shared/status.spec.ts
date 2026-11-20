import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BuildStatus } from '@dreamdevops/contracts/builds/http';
import type { DeploymentStatus } from '@dreamdevops/contracts/deployments/http';
import type { TargetStatus } from '@dreamdevops/contracts/environments/http';
import type { ReleaseStatus } from '@dreamdevops/contracts/releases/http';
import {
  buildStatus,
  deploymentStatus,
  releaseStatus,
  type Status,
  StatusBadge,
  statusText,
  stepStatus,
  targetStatus,
} from './status';
import type { StepStatus } from './steps';

describe('the shared status vocabulary', () => {
  it.each<[BuildStatus, string, string]>([
    ['queued', 'queued', 'Queued'],
    ['running', 'running', 'Running'],
    ['succeeded', 'passed', 'Passed'],
    ['failed', 'failed', 'Failed'],
    ['deleted', 'inactive', 'Deleted'],
  ])('reads a %s build as %s', (value, state, text) => {
    expect(buildStatus(value).state).toBe(state);
    expect(statusText(buildStatus(value))).toBe(text);
  });

  it.each<[StepStatus, string, string]>([
    ['pending', 'queued', 'Queued'],
    ['running', 'running', 'Running'],
    ['passed', 'passed', 'Passed'],
    ['failed', 'failed', 'Failed'],
    ['skipped', 'inactive', 'Skipped'],
  ])('reads a %s step as %s', (value, state, text) => {
    expect(stepStatus(value).state).toBe(state);
    expect(statusText(stepStatus(value))).toBe(text);
  });

  it.each<[DeploymentStatus, string, string]>([
    ['awaiting-approval', 'awaiting-approval', 'Waiting for approval'],
    ['rejected', 'inactive', 'Rejected'],
    ['queued', 'queued', 'Queued'],
    ['committed', 'running', 'Running · Waiting for the target'],
    ['progressing', 'running', 'Running · Rolling out'],
    ['paused', 'awaiting-approval', 'Waiting for approval · Waiting to switch traffic'],
    ['succeeded', 'passed', 'Passed'],
    ['failed', 'failed', 'Failed'],
    ['aborted', 'inactive', 'Aborted'],
    ['superseded', 'inactive', 'Replaced by a newer deployment'],
  ])('reads a %s deployment as %s', (value, state, text) => {
    expect(deploymentStatus(value).state).toBe(state);
    expect(statusText(deploymentStatus(value))).toBe(text);
  });

  it.each<[ReleaseStatus, string, string]>([
    ['open', 'running', 'Running · Open'],
    ['merged', 'running', 'Running · Building the final image'],
    ['published', 'passed', 'Passed · Published'],
  ])('reads a %s release as %s', (value, state, text) => {
    expect(releaseStatus(value).state).toBe(state);
    expect(statusText(releaseStatus(value))).toBe(text);
  });

  it.each<[TargetStatus, string, string]>([
    ['pending', 'queued', 'Queued · Waiting for the agent'],
    ['connected', 'healthy', 'Healthy · Connected'],
    ['lost', 'degraded', 'Degraded · Not reporting'],
    ['revoked', 'inactive', 'Disconnected'],
  ])('reads a %s target as %s', (value, state, text) => {
    expect(targetStatus(value).state).toBe(state);
    expect(statusText(targetStatus(value))).toBe(text);
  });

  it('shows a value it does not know as itself, rather than breaking', () => {
    expect(buildStatus('archived' as BuildStatus)).toEqual({ state: 'inactive', detail: 'archived' });
  });
});

@Component({
  imports: [StatusBadge],
  template: `<app-status [status]="status()" [symbol]="symbol()" />`,
})
class Host {
  readonly status = signal<Status>({ state: 'running', detail: 'Rolling out' });
  readonly symbol = signal(true);
}

describe('StatusBadge', () => {
  async function render(status: Status, symbol = true): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.status.set(status);
    fixture.componentInstance.symbol.set(symbol);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows the symbol, the word and its color, then the detail', async () => {
    const element = await render({ state: 'running', detail: 'Rolling out' });
    const badge = element.querySelector('.status')!;

    expect(badge.getAttribute('data-state')).toBe('running');
    expect(badge.textContent?.trim()).toBe('◐ Running');
    expect(badge.querySelector('.status-symbol')?.getAttribute('aria-hidden')).toBe('true');
    expect(element.querySelector('.status-detail')?.textContent).toBe(', Rolling out');
  });

  it('calls an inactive status by what happened, with no detail after it', async () => {
    const element = await render({ state: 'inactive', detail: 'Aborted' });

    expect(element.querySelector('.status')?.textContent?.trim()).toBe('– Aborted');
    expect(element.querySelector('.status-detail')).toBeNull();
  });

  it('leaves the symbol out when asked, where it is shown already', async () => {
    const element = await render({ state: 'passed', detail: null }, false);

    expect(element.querySelector('.status-symbol')).toBeNull();
    expect(element.querySelector('.status')?.textContent?.trim()).toBe('Passed');
  });
});
