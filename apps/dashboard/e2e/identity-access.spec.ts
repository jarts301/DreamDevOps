import { expect, test } from '@playwright/test';
import {
  createCompanyAndInvite,
  invitationLink,
  newUser,
  openAsNewPerson,
  overflowOnPhone,
  register,
  SAMPLE_PASSWORD,
  signIn,
} from './support';

test('from starting a company to managing its team', async ({ browser, page }) => {
  const admin = newUser('admin');
  const developer = newUser('developer');

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

  let adminLink = '';
  await test.step('the platform admin creates a company and invites its first admin', async () => {
    adminLink = await createCompanyAndInvite(page, `E2E ${admin.username}`, admin.email);
  });

  const adminPage = await openAsNewPerson(browser, adminLink);

  await test.step('the first admin registers and must click to join', async () => {
    await expect(adminPage).toHaveURL(/\/realms\/dreamdevops\//);
    await register(adminPage, admin);
    await expect(adminPage.getByRole('button', { name: 'Accept invitation' })).toBeVisible();
    await expect(adminPage).toHaveURL(/\/invitations\/accept$/);
    await adminPage.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(adminPage.getByText('Your role is Company Admin.')).toBeVisible();
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
    expect(await overflowOnPhone(adminPage)).toBe(0);
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

  await test.step('signing out ends the login provider session too', async () => {
    await adminPage.getByRole('button', { name: 'Sign out' }).click();
    await expect(adminPage).toHaveURL(/\/realms\/dreamdevops\//);
    await expect(adminPage.getByLabel('Password', { exact: true })).toBeVisible();
  });

  await developerPage.context().close();
  await adminPage.context().close();
});
