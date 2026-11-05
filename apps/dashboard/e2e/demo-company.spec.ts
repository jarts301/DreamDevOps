import { expect, test } from '@playwright/test';
import { openFromMenu, SAMPLE_PASSWORD, signIn } from './support';

// npm run start:api creates the demo company and these users. The README lists them.
const DEMO_USERS = [
  { username: 'demo-company-admin', role: 'Company Admin', menu: ['Overview', 'Applications', 'Team'], registers: true },
  { username: 'demo-tech-lead', role: 'Tech Lead', menu: ['Overview', 'Applications'], registers: true },
  { username: 'demo-developer', role: 'Developer', menu: ['Overview', 'Applications'], registers: false },
  { username: 'demo-operator', role: 'Operator', menu: ['Overview', 'Applications'], registers: false },
  { username: 'demo-viewer', role: 'Viewer', menu: ['Overview', 'Applications'], registers: false },
];

for (const user of DEMO_USERS) {
  test(`${user.username} works in the demo company as ${user.role}`, async ({ page }) => {
    await page.goto('/');
    await signIn(page, user.username, SAMPLE_PASSWORD);
    await expect(page.getByRole('heading', { name: /Welcome, Demo / })).toBeVisible();

    // The company is ready once its Git organization is, seconds after the API starts.
    await expect(async () => {
      await page.reload();
      await expect(page.locator('.topbar-company')).toHaveText(`Demo Company · ${user.role}`, { timeout: 1_000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByText(`You're working in Demo Company. Your role is ${user.role}.`)).toBeVisible();

    const menu = page.getByRole('navigation', { name: 'Main' }).getByRole('link');
    await expect(menu).toHaveText(user.menu);

    await openFromMenu(page, 'Applications');
    await expect(page.getByRole('heading', { level: 1, name: 'Applications' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create application' })).toHaveCount(user.registers ? 1 : 0);
  });
}

test('the demo Company Admin sees one member in each role', async ({ page }) => {
  await page.goto('/');
  await signIn(page, 'demo-company-admin', SAMPLE_PASSWORD);
  await openFromMenu(page, 'Team');

  for (const user of DEMO_USERS) {
    await expect(page.getByRole('combobox', { name: `Role of Demo ${user.role}` })).toHaveValue(
      user.username.replace('demo-', ''),
    );
  }
});
