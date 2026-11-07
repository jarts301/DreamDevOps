import { createHmac, randomBytes } from 'node:crypto';
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

/** A one-time code from Keycloak's raw secret, as an authenticator app makes it (RFC 6238). */
const totp = (secret: string) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hash = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = hash[hash.length - 1]! & 0xf;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};

/**
 * Admins and Tech Leads set up an authenticator when Keycloak first asks for a second factor.
 * Just after registering, Keycloak asks for the password once more first.
 */
const setUpSecondFactor = async (page: Page, password?: string) => {
  const secret = page.locator('#totpSecret');
  const passwordField = page.getByLabel('Password', { exact: true });
  await expect(secret.or(passwordField)).toBeAttached({ timeout: 30_000 });
  if (password !== undefined && (await passwordField.count()) > 0) {
    await passwordField.fill(password);
    await page.getByRole('button', { name: 'Sign In' }).click();
  }
  await expect(secret).toBeAttached();
  await page.locator('#totp').fill(totp((await secret.getAttribute('value'))!));
  await page.locator('#userLabel').fill('E2E phone');
  await page.getByRole('button', { name: 'Submit' }).click();
};

const KEYCLOAK = `http://localhost:${process.env['KEYCLOAK_PORT'] ?? '8081'}`;

/** Removes a sample user's authenticator, so every run sets one up as a new admin would. */
const removeAuthenticator = async (username: string) => {
  const token = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: process.env['KEYCLOAK_ADMIN_USERNAME']!,
      password: process.env['KEYCLOAK_ADMIN_PASSWORD']!,
    }),
  });
  const { access_token: accessToken } = (await token.json()) as { access_token: string };
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(`${KEYCLOAK}/admin/realms/dreamdevops${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  const [user] = (await (await admin(`/users?exact=true&username=${username}`)).json()) as { id: string }[];
  const credentials = (await (await admin(`/users/${user!.id}/credentials`)).json()) as { id: string; type: string }[];
  for (const credential of credentials.filter(({ type }) => type === 'otp')) {
    await admin(`/users/${user!.id}/credentials/${credential.id}`, { method: 'DELETE' });
  }
};

const invitationLink = (page: Page) => page.getByRole('textbox', { name: 'Invitation link' }).inputValue();

const MAILPIT = `http://localhost:${process.env['MAILPIT_WEB_PORT'] ?? '8025'}`;

/** Reads the invitation link from the email Mailpit caught, as the invited person would. */
const linkFromEmail = async (address: string): Promise<string> => {
  let text = '';
  await expect
    .poll(
      async () => {
        const search = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
        const { messages } = (await search.json()) as { messages: { ID: string }[] };
        if (messages.length === 0) {
          return false;
        }
        const message = await fetch(`${MAILPIT}/api/v1/message/${messages[0]!.ID}`);
        text = ((await message.json()) as { Text: string }).Text;
        return true;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return /(http\S+invitations\/accept#token=\S+)/.exec(text)![1]!;
};

test('from starting a company to managing its team', async ({ browser, page }) => {
  const admin = newUser('admin');
  const developer = newUser('developer');
  const companyName = `E2E Company ${admin.username.slice(-8)}`;
  const companyRow = () => page.getByRole('row', { name: new RegExp(companyName) });
  await removeAuthenticator('dev-platform-admin');

  await test.step('anonymous users go to the login page', async () => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/realms\/dreamdevops\//);
  });

  await test.step('a wrong password is refused', async () => {
    await signIn(page, 'dev-platform-admin', 'wrong-password');
    await expect(page.getByText('Invalid username or password')).toBeVisible();
  });

  await test.step('a platform admin signs in with a second factor and sees no company data', async () => {
    await signIn(page, 'dev-platform-admin', SAMPLE_PASSWORD);
    await setUpSecondFactor(page);
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

  await test.step('the invitation is emailed', async () => {
    await expect(page.getByText('We emailed them the link.')).toBeVisible();
  });

  const adminLink = await linkFromEmail(admin.email);
  expect(adminLink).toBe(await invitationLink(page));
  const adminPage = await openAsNewPerson(browser, adminLink);

  await test.step('the first admin registers and must click to join', async () => {
    await expect(adminPage).toHaveURL(/\/realms\/dreamdevops\//);
    await register(adminPage, admin);
    await expect(adminPage.getByRole('button', { name: 'Accept invitation' })).toBeVisible();
    await expect(adminPage).toHaveURL(/\/invitations\/accept$/);
    await adminPage.getByRole('button', { name: 'Accept invitation' }).click();
    // Company Admins need a second factor, so Keycloak asks for one before they go on.
    await setUpSecondFactor(adminPage, admin.password);
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

  const developerPage = await openAsNewPerson(browser, await linkFromEmail(developer.email));

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
    // Now a Company Admin, they set up a second factor before seeing the page.
    await setUpSecondFactor(developerPage, developer.password);
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

  await test.step('the audit log shows every change, and is intact', async () => {
    await adminPage.getByRole('link', { name: 'Audit log' }).click();
    await expect(adminPage).toHaveURL(/\/audit$/);
    // Entries are recorded in the background, so the newest may need a moment to appear.
    await expect(async () => {
      await adminPage.reload();
      await expect(adminPage.getByRole('cell', { name: 'Removed a member who was Company Admin' })).toBeVisible({
        timeout: 5_000,
      });
    }).toPass({ timeout: 30_000 });
    await expect(adminPage.getByRole('cell', { name: `Created the company "${companyName}"` })).toBeVisible();
    await adminPage.getByRole('button', { name: 'Check integrity' }).click();
    await expect(adminPage.getByText(/The log is intact\. \d+ entries checked\./)).toBeVisible();
  });

  await test.step('the company admin sees what the Community Edition includes', async () => {
    await adminPage.getByRole('link', { name: 'Edition', exact: true }).click();
    await expect(adminPage.getByText('Your company uses the Community Edition.')).toBeVisible();
    await expect(adminPage.getByText('Tamper-evident audit history')).toBeVisible();
    await expect(adminPage.getByText('These need the Commercial Edition.', { exact: false })).toBeVisible();
  });

  await test.step('the company admin registers an application', async () => {
    await adminPage.getByRole('link', { name: 'Applications' }).click();
    await adminPage.getByLabel('Name', { exact: true }).fill('Billing API');
    await adminPage.getByLabel('Type').selectOption({ label: 'RESTful Service' });
    await adminPage.getByLabel('Description (optional)').fill('Charges customers');
    await adminPage.getByRole('button', { name: 'Register application' }).click();
    await expect(adminPage.getByText('Billing API is registered.')).toBeVisible();
    await expect(adminPage.getByRole('cell', { name: 'billing-api', exact: true })).toBeVisible();
  });

  const repository = `${companyName.toLowerCase().replaceAll(' ', '-')}/billing-api`;

  await test.step('its repository is created in Forgejo from the blueprint', async () => {
    // The page refreshes on its own while the repository is being created.
    await expect(adminPage.getByRole('link', { name: repository })).toBeVisible({ timeout: 60_000 });
    await expect(adminPage.getByText('From node-service 1.0.0')).toBeVisible();
  });

  await test.step('the company admin signs in to Forgejo through Keycloak and joins their team', async () => {
    await expect(adminPage.getByText('Sign in to Forgejo once with your DreamDevOps account')).toBeVisible();
    const [forgejo] = await Promise.all([
      adminPage.waitForEvent('popup'),
      adminPage.getByRole('link', { name: 'Sign in to Forgejo' }).click(),
    ]);
    // Already signed in to Keycloak, so Forgejo creates the account without asking again.
    await forgejo.waitForURL((url) => url.port === '3000' && !url.pathname.startsWith('/user/'));
    await adminPage.getByRole('button', { name: 'Check again' }).click();
    await expect(adminPage.getByText("You're in the Readers team now.")).toBeVisible();

    await forgejo.goto(`http://localhost:3000/${repository}`);
    await expect(forgejo.getByText('package.json', { exact: true })).toBeVisible();
    await expect(forgejo.getByText('develop', { exact: true }).first()).toBeVisible();
    await forgejo.close();
  });

  await test.step("the application's page shows its repository, releases and versions", async () => {
    await adminPage.getByRole('link', { name: 'Billing API', exact: true }).click();
    await expect(adminPage).toHaveURL(/\/applications\/[0-9a-f-]{36}$/);
    await expect(adminPage.getByRole('heading', { name: 'Billing API', level: 1 })).toBeVisible();
    await expect(adminPage.getByRole('link', { name: repository })).toBeVisible();
    await expect(adminPage.getByText('No releases yet.')).toBeVisible();
    await expect(adminPage.getByText('No versions yet.')).toBeVisible();
    // Company Admins don't build images or start releases; Developers and Tech Leads do.
    await expect(adminPage.getByRole('heading', { name: 'Build a feature image' })).toHaveCount(0);
    await expect(adminPage.getByRole('button', { name: 'Start' })).toHaveCount(0);
    await adminPage.getByRole('link', { name: '← Applications' }).click();
    await expect(adminPage).toHaveURL(/\/applications$/);
  });

  await test.step('the platform admin sees each company’s edition, and only Community is installed', async () => {
    await expect(page.getByRole('link', { name: 'Edition', exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: 'Editions' }).click();
    await expect(page.getByText('Only the Community Edition is installed', { exact: false })).toBeVisible();
    const edition = page.getByRole('combobox', { name: `Edition of ${companyName}` });
    await expect(edition).toHaveValue('community');
    await expect(edition).toBeDisabled();
    await page.getByRole('link', { name: 'Companies' }).click();
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
