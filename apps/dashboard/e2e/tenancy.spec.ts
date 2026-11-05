import { expect, test } from '@playwright/test';
import {
  createCompanyAndInvite,
  invitationLink,
  newUser,
  openAsNewPerson,
  openFromMenu,
  overflowOnPhone,
  register,
  SAMPLE_PASSWORD,
  signIn,
} from './support';

/** Asks Git hosting directly, as its administrator, so the test sees what really happened there. */
const gitHosting = async (path: string) => {
  const authorization = Buffer.from(`${process.env['FORGEJO_ADMIN_USERNAME']}:${process.env['FORGEJO_ADMIN_PASSWORD']}`);
  const response = await fetch(`http://localhost:${process.env['FORGEJO_HTTP_PORT'] ?? '3000'}/api/v1${path}`, {
    headers: { Authorization: `Basic ${authorization.toString('base64')}` },
  });
  expect(response.status, `GET ${path}`).toBe(200);
  return (await response.json()) as unknown;
};

test('a company from creation to closing, with its applications', async ({ browser, page }) => {
  const admin = newUser('tenant-admin');
  const viewer = newUser('tenant-viewer');
  const companyName = `E2E Tenancy ${admin.username.slice(-8)}`;

  await test.step('the platform admin creates a company, which gets its Git organization', async () => {
    await page.goto('/');
    await signIn(page, 'dev-platform-admin', SAMPLE_PASSWORD);
    await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
    const link = await createCompanyAndInvite(page, companyName, admin.email);
    const organization = page.getByRole('row', { name: /Git organization/ });
    await expect(organization.getByText('Ready')).toBeVisible();
    await expect(organization.getByRole('link')).toHaveAttribute('href', /\/e2e-tenancy-[0-9a-f]{8}$/);

    const adminPage = await openAsNewPerson(browser, link);
    await register(adminPage, admin);
    await adminPage.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(adminPage.getByText(`You're working in ${companyName}.`)).toBeVisible();
    await adminPage.close();
  });

  await test.step('the companies page lists it, and fits a phone', async () => {
    await openFromMenu(page, 'Companies');
    const row = page.getByRole('row', { name: new RegExp(companyName) });
    await expect(row.getByText('Active')).toBeVisible();
    await expect(row.getByRole('cell', { name: '1', exact: true })).toBeVisible();
    expect(await overflowOnPhone(page)).toBe(0);
  });

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await adminPage.goto('/');
  await signIn(adminPage, admin.username, admin.password);

  await test.step('the company admin sees the company by name', async () => {
    await expect(adminPage.locator('.topbar-company')).toHaveText(`${companyName} · Company Admin`);
  });

  await test.step('the application types explain what each kind of application needs', async () => {
    await openFromMenu(adminPage, 'Applications');
    await adminPage.getByRole('link', { name: 'See what each application type needs' }).click();
    for (const name of ['Python frontend', 'TypeScript frontend', 'Python backend', 'TypeScript backend']) {
      await expect(adminPage.getByRole('heading', { level: 3, name: new RegExp(`^${name}`) })).toBeVisible();
    }
    const backend = adminPage.getByRole('region', { name: /^TypeScript backend/ });
    await expect(backend.getByRole('cell', { name: 'npm run migrate' })).toBeVisible();
  });

  await test.step('the company admin registers, edits, archives and restores an application', async () => {
    await openFromMenu(adminPage, 'Applications');
    await expect(adminPage.getByText('No applications yet.')).toBeVisible();
    await expect(adminPage.getByRole('button', { name: 'Create application' })).toBeDisabled();
    await adminPage.getByRole('radio', { name: /^TypeScript backend/ }).check();
    // A type offers its own scaffolds, and the first is chosen for it.
    await expect(adminPage.getByRole('radio', { name: /^NestJS/ })).toBeChecked();
    await expect(adminPage.getByText(/^Includes: .*Supertest/)).toBeVisible();
    await adminPage.getByLabel('Application name').fill('Billing API');
    await expect(adminPage.getByLabel('Slug')).toHaveValue('billing-api');
    await adminPage.getByLabel('Description (optional)').fill('Bills customers every month.');
    await adminPage.getByRole('button', { name: 'Create application' }).click();
    const active = adminPage.getByRole('region', { name: 'Active applications' });
    await expect(active.getByRole('cell', { name: 'Billing API', exact: true })).toBeVisible();
    await expect(active.getByRole('cell', { name: 'TypeScript backend · NestJS', exact: true })).toBeVisible();
    // The repository is made in the background, and the page updates by itself.
    const repository = active.getByRole('row', { name: /Billing API/ }).getByRole('link', { name: 'billing-api' });
    await expect(repository).toBeVisible({ timeout: 30_000 });
    await expect(repository).toHaveAttribute('href', /\/e2e-tenancy-[0-9a-f]{8}\/billing-api$/);
    const organization = new URL((await repository.getAttribute('href'))!).pathname.split('/')[1]!;
    // Git hosting's own first commit, then the scaffold's, and topics saying what it is.
    const commits = (await gitHosting(`/repos/${organization}/billing-api/commits?sha=main&limit=5`)) as unknown[];
    expect(commits).toHaveLength(2);
    const { topics } = (await gitHosting(`/repos/${organization}/billing-api/topics`)) as { topics: string[] };
    expect(topics).toEqual(['typescript-backend', 'nestjs']);

    await adminPage.getByRole('button', { name: 'Edit Billing API' }).click();
    await adminPage.getByLabel('Name', { exact: true }).fill('Billing Service');
    await adminPage.getByRole('button', { name: 'Save changes' }).click();
    await expect(active.getByRole('cell', { name: 'Billing Service', exact: true })).toBeVisible();

    await adminPage.getByRole('button', { name: 'Archive Billing Service' }).click();
    const archived = adminPage.getByRole('region', { name: 'Archived applications' });
    await expect(archived.getByRole('cell', { name: 'Billing Service', exact: true })).toBeVisible();
    await expect(active.getByText('No applications yet.')).toBeVisible();

    await adminPage.getByRole('button', { name: 'Restore Billing Service' }).click();
    await expect(active.getByRole('cell', { name: 'Billing Service', exact: true })).toBeVisible();
    await expect(archived).toHaveCount(0);
  });

  await test.step('a slug the company already uses is refused', async () => {
    await adminPage.getByRole('radio', { name: /^Python frontend/ }).check();
    await adminPage.getByLabel('Application name').fill('Billing Service');
    await adminPage.getByLabel('Slug').fill('billing-api');
    await adminPage.getByRole('button', { name: 'Create application' }).click();
    await expect(adminPage.getByRole('alert')).toContainText('already uses the slug "billing-api"');
  });

  await test.step('each type can be registered', async () => {
    await adminPage.getByRole('radio', { name: /^Python backend/ }).check();
    await adminPage.getByLabel('Application name').fill('Pricing Engine');
    await adminPage.getByLabel('Slug').fill('pricing-engine');
    await adminPage.getByRole('button', { name: 'Create application' }).click();
    const active = adminPage.getByRole('region', { name: 'Active applications' });
    await expect(active.getByRole('row', { name: /Pricing Engine/ }).getByText('Python backend')).toBeVisible();
    await expect(active.getByRole('row', { name: /Pricing Engine/ }).getByRole('link', { name: 'pricing-engine' })).toBeVisible({
      timeout: 30_000,
    });
  });

  await test.step('the applications page fits a phone', async () => {
    expect(await overflowOnPhone(adminPage)).toBe(0);
  });

  const viewerPage = await test.step('a viewer sees the applications but cannot change them', async () => {
    await openFromMenu(adminPage, 'Team');
    await adminPage.getByLabel('Email').fill(viewer.email);
    await adminPage.locator('form').getByRole('combobox').selectOption('viewer');
    await adminPage.getByRole('button', { name: 'Create invitation' }).click();
    const joining = await openAsNewPerson(browser, await invitationLink(adminPage));
    await register(joining, viewer);
    await joining.getByRole('button', { name: 'Accept invitation' }).click();
    await openFromMenu(joining, 'Applications');
    await expect(joining.getByRole('cell', { name: 'Billing Service', exact: true })).toBeVisible();
    await expect(joining.getByLabel('Application name')).toHaveCount(0);
    await expect(joining.getByRole('button', { name: 'Archive Billing Service' })).toHaveCount(0);
    return joining;
  });

  const companyPage = async () => {
    await openFromMenu(page, 'Companies');
    await page.getByRole('link', { name: companyName, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: companyName })).toBeVisible();
  };

  await test.step('suspending the company takes its members access away at once', async () => {
    await companyPage();
    await page.getByRole('button', { name: 'Suspend company' }).click();
    await expect(page.locator('.lead .badge')).toHaveText('Suspended');

    await viewerPage.reload();
    await expect(viewerPage.getByRole('heading', { name: "You don't have access to this page" })).toBeVisible();
    await adminPage.goto('/');
    await expect(adminPage.getByRole('heading', { name: "You're not in an active company" })).toBeVisible();
    await expect(adminPage.getByRole('link', { name: 'Applications' })).toHaveCount(0);
  });

  await test.step('reactivating gives it back', async () => {
    await page.getByRole('button', { name: 'Reactivate company' }).click();
    await expect(page.locator('.lead .badge')).toHaveText('Active');

    await viewerPage.goto('/applications');
    await expect(viewerPage.getByRole('cell', { name: 'Billing Service', exact: true })).toBeVisible();
  });

  await test.step('renaming shows the new name to members', async () => {
    await page.getByLabel('Company name').fill(`${companyName} Renamed`);
    await page.getByRole('button', { name: 'Save name' }).click();
    await expect(page.getByRole('heading', { level: 1, name: `${companyName} Renamed` })).toBeVisible();

    await adminPage.reload();
    await expect(adminPage.locator('.topbar-company')).toHaveText(`${companyName} Renamed · Company Admin`);
  });

  await test.step('closing asks first, and is permanent', async () => {
    await page.getByRole('button', { name: 'Close company' }).click();
    await page.getByRole('button', { name: 'Confirm close' }).click();
    await expect(page.locator('.lead .badge')).toHaveText('Closed');
    await expect(page.getByText('This company is closed.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reactivate company' })).toHaveCount(0);

    await adminPage.reload();
    await expect(adminPage.getByRole('heading', { name: "You're not in an active company" })).toBeVisible();
  });

  await test.step('erasing replaces everything that identifies the company', async () => {
    const slug = await page.locator('.lead code').innerText();
    await expect(page.getByRole('button', { name: 'Erase company data' })).toBeDisabled();
    await page.getByLabel(`Type the slug ${slug} to confirm`).fill(slug);
    await page.getByRole('button', { name: 'Erase company data' }).click();

    await expect(page.locator('.lead .badge')).toHaveText('Erased');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Erased company [0-9a-f]{8}$/);
    const organization = page.getByRole('row', { name: /Git organization/ });
    await expect(organization.getByText('Erased', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("This company's data was erased on")).toBeVisible();

    await openFromMenu(page, 'Companies');
    await expect(page.getByRole('cell', { name: new RegExp(companyName) })).toHaveCount(0);
  });

  await viewerPage.context().close();
  await adminContext.close();
});
