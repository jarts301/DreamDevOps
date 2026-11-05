# Tenancy

Knows which companies exist, where each one is in its lifecycle, what it needs in other tools, and which applications it has. Identity and Access decides who may act for a company. This module decides whether the company itself can be used.

## A company's lifecycle

| Status | Members have access | How it gets here |
|---|---|---|
| Provisioning | No | A Platform Admin creates the company |
| Active | Yes | Every required resource is ready, or a Platform Admin reactivates it |
| Suspended | No | A Platform Admin suspends an active company |
| Closed | No | A Platform Admin closes it. This is permanent. |
| Erased | No | A Platform Admin erases a closed company's data. This is permanent. |

Members keep their membership while their company isn't active, so suspending and reactivating a company gives the same people the same roles. Only an active company can take a first admin, and invitations can only be accepted while it's active.

A company's slug names its resources in other tools, so it can't change, and no other company can ever use it. Its name can change at any time.

## Resources

Each company needs these before it becomes active:

| Resource | Where | What DreamDevOps creates |
|---|---|---|
| Git organization | Forgejo | A private organization named after the company's slug, with the company's name as its display name |

Provisioning runs in the background, so a slow or unreachable tool never holds up a request:

1. Creating a company saves it, its pending resources and a `CompanyCreated` event in one transaction.
2. The outbox relay delivers the event, and the job queue runs provisioning inside the company's context.
3. Each resource is created or brought up to date. When all of them are ready, the company becomes active and `CompanyProvisioned` is published.

Provisioning can run any number of times without harm. Forgejo records the company's ID in each organization's description, so after a crash DreamDevOps recognizes an organization it created and doesn't fail on it. Renaming a company runs provisioning again, which updates the organization's display name.

| When provisioning fails because | What happens |
|---|---|
| Git hosting can't be reached or answers with an error | The resource shows as failed, and the job runs again up to 5 times, 20 seconds apart |
| The name is reserved, belongs to an account, or belongs to an organization DreamDevOps didn't create | The resource shows as failed, with the reason, and isn't retried |
| Git hosting refuses DreamDevOps's credentials | The same, until someone fixes the API's Forgejo settings |

A Platform Admin can retry provisioning at any time, which runs it again for every resource. Closing a company stops provisioning. Nothing in another tool is deleted when a company closes. Its Git organization stays until the company's data is erased.

Companies that existed before this module got a name based on their ID, stayed active, and have a pending Git organization. A Platform Admin starts its provisioning with **Retry provisioning**.

## Applications

Each company has its own applications, with a name, a description and a slug that is unique within the company. Each is registered as one type from the [Application Catalog](../application-catalog/README.md), such as a TypeScript frontend, and one of that type's scaffolds, such as Angular, or none for an empty repository. Neither can change, because they decide how the application is built and run. Applications registered before types existed have neither.

Archiving an application keeps it and its slug, so its history stays readable, and restoring it brings it back. Archived applications can't be changed until they're restored. Nothing is ever deleted.

### Repositories

Each application gets a private repository in its company's Git organization, named after its slug, with `main` as its default branch. DreamDevOps makes it in the background, talking to Forgejo only through its REST API, so the API needs no git connection of its own:

1. Registering an application saves it, a pending repository and an `ApplicationCreated` event in one transaction.
2. The job makes sure the company's organization is in Forgejo, and makes it again if it has gone, such as after Forgejo's data was reset.
3. It creates the repository with Forgejo's own first commit, which holds a README, or finds the one already there. It sets the repository's topics to the application's type and scaffold, such as `typescript-frontend` and `angular`, so Forgejo shows what the repository holds.
4. With a scaffold, it fills the scaffold in and adds every file as one more commit, by DreamDevOps, which replaces Forgejo's README. It does this only while the repository has just Forgejo's first commit, so running the job again, or after someone has committed, changes nothing.

In Forgejo, at <http://localhost:3000> locally, each company is an organization and each application a repository in it. Sign in as the Forgejo administrator, `FORGEJO_ADMIN_USERNAME` with `FORGEJO_ADMIN_PASSWORD` from `infra/local/.env`, to see them, because they're private.

| When it fails because | What happens |
|---|---|
| Git hosting can't be reached, or the company's organization isn't ready yet | The repository shows as failed, and the job runs again up to 5 times, 20 seconds apart |
| Git hosting refuses the name, the files or DreamDevOps's credentials | The repository shows as failed, with the reason, and isn't retried |

Anyone who may create applications can retry a failed repository. Archiving an application keeps its repository.

| Action | Permission | Who has it |
|---|---|---|
| See the company | `dashboards:view` | Every company role |
| See applications | `applications:view` | Every company role |
| Create applications | `applications:create` | Company Admin, Tech Lead |
| Change their names and descriptions | `applications:update` | Company Admin, Tech Lead |
| Archive and restore them | `applications:archive` | Company Admin, Tech Lead |

Each is checked on its own, so a role can have any mix of them. The [role matrix](../identity-access/README.md#roles) also assigns `applications:configure`, `migrate`, `run`, `test` and `monitor`, for the features that will use them.

## Erasing a company's data

Data protection laws can require a company's data to be deleted. Erasing keeps the company's rows, so history and references stay whole, and replaces everything in them that could identify the company, its applications or the people it invited:

| Data | What erasing does |
|---|---|
| The company's name and slug | Become `Erased company 4707316c` and `erased-` followed by its ID |
| Its applications' names, slugs and descriptions | Become `Erased application`, `erased-` followed by the application's ID, and empty. Every application is archived. |
| The email addresses in its invitations | Become `erased-<invitation ID>@erased.invalid`, and every open invitation is revoked |
| Its applications' repositories in Forgejo | Are deleted in the background, first |
| Its Git organization in Forgejo | Is deleted in the background, once it has no repositories |
| Its events | Need no change, because event payloads hold only IDs |

1. A Platform Admin closes the company, then confirms erasing it by typing its slug.
2. One database function, `tenancy.erase_current_company()`, replaces the data in one transaction. It refuses unless the company is closed.
3. In the background, DreamDevOps deletes its applications' repositories, then the company's Git organization, only if it created it for this company. An organization that still has other repositories, such as ones people made in Forgejo, is kept, and the resource shows as failed until someone deletes or moves them and chooses **Retry erasure**. Failures from Forgejo being unreachable are retried by themselves.

Erasing can't be undone, and an erased company can't change. Its old slug is free for a new company.

Erasing doesn't touch what isn't the company's, or what this module can't reach:

- **User accounts** belong to people, who may be members of other companies too. Their memberships stay, and grant nothing.
- **Backups** keep earlier copies until they expire.
- **Logs** keep what they recorded until they rotate. Provisioning and erasure errors name Forgejo's endpoints rather than organizations, so they hold no company names.

## Routes

All routes start with `/api/v1`. Platform routes act on the company in the path, and company routes act on the signed-in user's current company.

| Route | Who | Purpose |
|---|---|---|
| `GET`, `POST /platform/companies` | `companies:manage` | Lists every company, or creates one from `name` and an optional `slug` |
| `GET`, `PATCH /platform/companies/:id` | `companies:manage` | Shows a company, or renames it |
| `POST /platform/companies/:id/suspend` | `companies:manage` | Suspends an active company |
| `POST /platform/companies/:id/reactivate` | `companies:manage` | Reactivates a suspended company |
| `POST /platform/companies/:id/close` | `companies:manage` | Closes a company for good |
| `POST /platform/companies/:id/erase` | `companies:manage` | Erases a closed company's data, confirmed with `confirmation` set to its slug |
| `POST /platform/companies/:id/provisioning` | `companies:manage` | Retries provisioning its resources, or erasing them if the company is erased |
| `GET /company` | `dashboards:view` | The current company, and its resources |
| `GET`, `POST /company/applications` | `applications:view` to list, `applications:create` to create | Lists applications with their repositories, or registers one from `type`, `scaffold`, `name`, and an optional `slug` and `description`. `scaffold` is one of the type's scaffolds, or `null` for an empty repository. |
| `GET`, `PATCH /company/applications/:id` | `applications:view` to read, `applications:update` to change | Shows an application, or changes its name or description |
| `POST /company/applications/:id/archive`, `/restore` | `applications:archive` | Archives or restores an application |
| `POST /company/applications/:id/repository` | `applications:create` | Retries making an application's repository |

Without a slug, one is made from the name, so "Acme Café" becomes `acme-cafe`. Slugs have 2 to 40 lowercase letters and digits, with single hyphens between them. A few company slugs, such as `admin` and `api`, are kept for Git hosting's own pages.

## Rules it enforces

- **Platform Admins see no company data:** they see each company's registry entry, resources and member count, never its applications or members.
- **Company data stays apart:** row-level security limits the registry and resources to the current company, and is forced on applications, so even their owner role can't read them without a company.
- **Some things never change:** the application role can't change a slug or delete anything. Only the erasure function replaces slugs.
- **Access follows the company:** only active companies count in Identity and Access, so suspending or closing a company takes effect on each member's next request.

## Events

| Event | When |
|---|---|
| `CompanyCreated`, `CompanyRenamed`, `CompanySuspended`, `CompanyReactivated`, `CompanyClosed`, `CompanyErased` | The lifecycle changes |
| `CompanyProvisioningRequested` | A Platform Admin retries provisioning |
| `CompanyResourceProvisioned`, `CompanyResourceFailed` | A resource becomes ready, or fails |
| `CompanyProvisioned` | Every resource is ready and the company becomes active |
| `CompanyResourceErased`, `CompanyResourceErasureFailed` | An erased company's resource is deleted, or can't be yet |
| `ApplicationCreated`, `ApplicationUpdated`, `ApplicationArchived`, `ApplicationRestored` | An application changes |
| `ApplicationRepositoryRequested`, `ApplicationRepositoryCreated`, `ApplicationRepositoryFailed`, `ApplicationRepositoryErased` | Someone retries a repository, or it's made, fails or is erased |

Payloads hold only IDs, such as who did something and which application it was, resource kinds, and application types and scaffolds. They never hold names, slugs, descriptions, email addresses or reasons for failures, so erasing a company never has to rewrite events, or the copies of them the job queue keeps for a while.

## Other modules

- **Identity and Access** reads each membership's company name and status in `identity.user_access`, which this module's migration redefined, and checks invitations with `tenancy.current_company_status()`. Its memberships and invitations have foreign keys to `tenancy.companies`.
- **Everything else** should use `tenancy.current_company_status()`, which answers for the current company, and this module's events, rather than its tables.
