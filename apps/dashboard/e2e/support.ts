import { randomBytes } from 'node:crypto';
import { type Browser, expect, type Page } from '@playwright/test';

process.loadEnvFile('../../infra/local/.env');
export const SAMPLE_PASSWORD = process.env['KEYCLOAK_DEV_USER_PASSWORD']!;

/** New users each run, so sample users stay out of test companies. */
export const newUser = (prefix: string) => {
  const username = `e2e-${prefix}-${randomBytes(4).toString('hex')}`;
  return { username, email: `${username}@example.com`, password: 'fake-dummy-e2e-user-password' };
};
export type NewUser = ReturnType<typeof newUser>;

export const signIn = async (page: Page, username: string, password: string) => {
  await page.getByLabel('Username or email').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
};

export const register = async (page: Page, user: NewUser) => {
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('#email').fill(user.email);
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#password-confirm').fill(user.password);
  await page.locator('#firstName').fill('E2E');
  await page.locator('#lastName').fill(user.username);
  await page.getByRole('button', { name: 'Register' }).click();
};

/** Opens a link in a fresh browser profile, as the invited person would. */
export const openAsNewPerson = async (browser: Browser, url: string) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  return page;
};

export const invitationLink = (page: Page) => page.getByRole('textbox', { name: 'Invitation link' }).inputValue();

/** Follows a link in the main navigation, rather than any link with the same words. */
export const openFromMenu = (page: Page, label: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label, exact: true }).click();

/**
 * Creates a company as a signed-in Platform Admin, waits until its resources are
 * provisioned, and invites its first admin. Returns the invitation link.
 */
export const createCompanyAndInvite = async (page: Page, companyName: string, adminEmail: string) => {
  await openFromMenu(page, 'Companies');
  await page.getByLabel('Company name').fill(companyName);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { level: 1, name: companyName })).toBeVisible();
  // Provisioning runs in the background, and the page updates by itself.
  await expect(page.locator('.lead .badge')).toHaveText('Active', { timeout: 30_000 });
  await page.getByLabel('Email of the first admin').fill(adminEmail);
  await page.getByRole('button', { name: 'Create invitation' }).click();
  await expect(page.getByRole('textbox', { name: 'Invitation link' })).toBeVisible();
  return invitationLink(page);
};

/** How far the page scrolls sideways at phone width. Zero means it fits. */
export const overflowOnPhone = async (page: Page) => {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 375, height: 812 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.setViewportSize(size);
  return overflow;
};
