# Tenancy

Keeps the register of companies and sets up the resources each one needs. Only platform admins manage companies, and they see names and states, never company data.

## Company lifecycle

| Action | Route | Effect |
|---|---|---|
| Create | `POST /platform/companies` | Creates the company and invites its first admin in one step, then sets up its resources in the background |
| Rename | `PATCH /platform/companies/:id` | Changes the name everywhere, including the Git organization's display name. The short name stays fixed. |
| Suspend | `POST /platform/companies/:id/suspend` | Blocks every member on their next request, and stops invitations from being accepted. Nothing is deleted. |
| Reactivate | `POST /platform/companies/:id/reactivate` | Restores access, then checks the company's resources again |
| Retry setup | `POST /platform/companies/:id/provision` | Tries setting up the resources again, such as after fixing what made it fail |
| Invite first admin | `POST /platform/companies/:id/first-admin-invitation` | Sends a new first-admin invitation. It only works while the company has no members. |
| List | `GET /platform/companies` | Every company with its state, and the reason if setup failed |

All routes start with `/api/v1` and need the `companies:manage` permission. Deleting companies isn't supported.

| State | Meaning |
|---|---|
| `provisioning` | Setting up its resources. Members can already join and work. |
| `active` | Every resource is ready |
| `provisioning-failed` | Setup stopped, and the reason is shown. A platform admin must retry it. |
| `suspended` | No member has access |

Each company also gets a **short name** (slug), made from its name when it's created, such as `acme-industries`. It names the company's resources and never changes. A similar name gets a number, such as `acme-industries-2`.

## Provisioning

Creating, renaming or reactivating a company publishes an event. The provisioning saga picks it up through the outbox and the job queue, and brings the company's resources in line, one step at a time.

| Resource | What it is |
|---|---|
| Git organization | A private Forgejo organization named after the short name, owned by the platform bot. It holds the company's repositories and images. |

Every step is safe to repeat. A failed step is retried, up to 5 attempts by default, 30 seconds apart. A failure that retrying can't fix, such as a name already taken in Forgejo, stops straight away. Either way, the company becomes `provisioning-failed` and shows the reason.

Before it changes an existing Forgejo organization, the saga checks the organization's description for the company's ID. That stops it from taking over an organization that belongs to someone else.

## The platform bot

The bot, `dreamdevops-bot`, is a Forgejo user that isn't an administrator. It's the only account allowed to create organizations, and it owns every company's organization. The local services create it, and its password is `FORGEJO_BOT_PASSWORD` in `infra/local/.env`.

## Events

Changes publish `CompanyCreated`, `CompanyRenamed`, `CompanySuspended`, `CompanyReactivated`, `CompanyProvisioningRequested`, `CompanyProvisioned` and `CompanyProvisioningFailed`. Their payloads hold names and IDs, not email addresses.
