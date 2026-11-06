import { randomBytes } from 'node:crypto';
import { type Browser, expect, type Page, test } from '@playwright/test';

process.loadEnvFile('../../infra/local/.env');
const SAMPLE_PASSWORD = process.env['KEYCLOAK_DEV_USER_PASSWORD']!;

/** New users each run, so sample users stay out of test companies. */
const newUser = (prefix: string) => {
  const username = `e2e-${prefix}-${randomBytes(4).toString('hex')}`;
  return { username, email: `${username}@example.com`, password: 'fake-dummy-e2e-user-password' };
};
type NewUser = ReturnType<typeof newUser>;

const signIn = async (page: Page, username: string, password: string) => {
  await page.getByLabel('Username or email').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
};

const register = async (page: Page, user: NewUser) => {
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
const openAsNewPerson = async (browser: Browser, url: string) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  return page;
};

const invitationLink = (page: Page) => page.getByRole('textbox', { name: 'Invitation link' }).inputValue();

test('from starting a company to managing its team', async ({ browser, page }) => {
  const admin = newUser('admin');
  const developer = newUser('developer');
  const companyName = `E2E Company ${admin.username.slice(-8)}`;
  const companyRow = () => page.getByRole('row', { name: new RegExp(companyName) });

  await test.step('anonymous users go to the login page', async () => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/realms\/dreamdevops\//);
  });

  await test.step('a wrong password is refused', async () => {
    await signIn(page, 'dev-platform-admin', 'wrong-password');
    await expect(page.getByText('Invalid username or password')).toBeVisible();
  });

  await test.step('a platform admin signs in and sees no company data', async () => {
    await signIn(page, 'dev-platform-admin', SAMPLE_PASSWORD);
    await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
    await expect(page.getByText("You can't see their data", { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Team' })).toHaveCount(0);
  });

  await test.step('the session cookie is hidden from scripts', async () => {
    await expect(page.evaluate(() => document.cookie)).resolves.not.toContain('dd_session');
  });

  await test.step('the platform admin starts a company', async () => {
    await page.getByRole('link', { name: 'Companies' }).click();
    await page.getByLabel('Company name').fill(companyName);
    await page.getByLabel('Email of the first admin').fill(admin.email);
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.getByRole('textbox', { name: 'Invitation link' })).toBeVisible();
  });

  await test.step('setting up the company finishes in the background', async () => {
    await expect(companyRow()).toContainText('Active', { timeout: 30_000 });
  });

  const adminLink = await invitationLink(page);
  const adminPage = await openAsNewPerson(browser, adminLink);

  await test.step('the first admin registers and must click to join', async () => {
    await expect(adminPage).toHaveURL(/\/realms\/dreamdevops\//);
    await register(adminPage, admin);
    await expect(adminPage.getByRole('button', { name: 'Accept invitation' })).toBeVisible();
    await expect(adminPage).toHaveURL(/\/invitations\/accept$/);
    await adminPage.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(adminPage.getByText('Your role is Company Admin.')).toBeVisible();
    await expect(adminPage.getByText(`You're working in ${companyName}.`)).toBeVisible();
  });

  await test.step('the admin invites a developer', async () => {
    await adminPage.getByRole('link', { name: 'Team' }).click();
    await adminPage.getByLabel('Email').fill(developer.email);
    await adminPage.locator('form').getByRole('combobox').selectOption('developer');
    await adminPage.getByRole('button', { name: 'Create invitation' }).click();
    await expect(adminPage.getByRole('textbox', { name: 'Invitation link' })).toBeVisible();
    await expect(adminPage.getByRole('cell', { name: developer.email, exact: true })).toBeVisible();
  });

  await test.step('the team page fits a phone without sideways scrolling', async () => {
    const size = adminPage.viewportSize()!;
    await adminPage.setViewportSize({ width: 375, height: 812 });
    const overflow = await adminPage.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
    await adminPage.setViewportSize(size);
  });

  await test.step('the invitation cannot be used by the wrong person', async () => {
    const link = await invitationLink(adminPage);
    const stranger = await openAsNewPerson(browser, link);
    await register(stranger, newUser('stranger'));
    await stranger.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(stranger.getByRole('alert')).toContainText('This invitation is not valid.');
    await stranger.context().close();
  });

  const developerPage = await openAsNewPerson(browser, await invitationLink(adminPage));

  await test.step('the developer joins with limited access', async () => {
    await register(developerPage, developer);
    await developerPage.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(developerPage.getByText('Your role is Developer.')).toBeVisible();
    await expect(developerPage.getByText('Build feature test images')).toBeVisible();
    await expect(developerPage.getByRole('link', { name: 'Team' })).toHaveCount(0);
  });

  await test.step('typing the address of a forbidden page does not help', async () => {
    await developerPage.goto('/team');
    await expect(developerPage.getByRole('heading', { name: "You don't have access to this page" })).toBeVisible();
  });

  await test.step('the last admin cannot be demoted', async () => {
    await adminPage.reload();
    const ownRole = adminPage.getByRole('combobox', { name: `Role of E2E ${admin.username}` });
    await ownRole.selectOption('viewer');
    await expect(adminPage.getByRole('alert')).toContainText('at least one Company Admin');
    await expect(ownRole).toHaveValue('company-admin');
  });

  await test.step('a role change applies at once', async () => {
    await adminPage
      .getByRole('combobox', { name: `Role of E2E ${developer.username}` })
      .selectOption('company-admin');
    await expect(adminPage.getByRole('alert')).toHaveCount(0);
    await developerPage.goto('/team');
    await expect(developerPage.getByRole('heading', { name: 'Team' })).toBeVisible();
  });

  await test.step('removal applies at once', async () => {
    await adminPage.getByRole('button', { name: `Remove E2E ${developer.username}` }).click();
    await adminPage.getByRole('button', { name: 'Confirm removal' }).click();
    await expect(adminPage.getByRole('cell', { name: developer.email, exact: true })).toHaveCount(0);
    await developerPage.reload();
    await expect(developerPage.getByRole('heading', { name: "You don't have access to this page" })).toBeVisible();
  });

  await test.step('suspending the company blocks its members at once', async () => {
    await page.getByRole('button', { name: `Suspend ${companyName}` }).click();
    await page.getByRole('button', { name: 'Confirm suspension' }).click();
    await expect(companyRow()).toContainText('Suspended');
    await adminPage.goto('/');
    await expect(adminPage.getByRole('heading', { name: "You're not in a company yet" })).toBeVisible();
  });

  await test.step('reactivating the company restores access', async () => {
    await page.getByRole('button', { name: `Reactivate ${companyName}` }).click();
    await expect(companyRow()).toContainText('Active', { timeout: 30_000 });
    await adminPage.goto('/team');
    await expect(adminPage.getByRole('heading', { name: 'Team' })).toBeVisible();
  });

  await test.step('signing out ends the login provider session too', async () => {
    await adminPage.getByRole('button', { name: 'Sign out' }).click();
    await expect(adminPage).toHaveURL(/\/realms\/dreamdevops\//);
    await expect(adminPage.getByLabel('Password', { exact: true })).toBeVisible();
  });

  await developerPage.context().close();
  await adminPage.context().close();
});
