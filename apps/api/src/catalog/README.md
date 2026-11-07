# Application Catalog

Keeps each company's register of applications, and the types of application they can register.

## Application types

A type is data, not code. The database starts with two:

| Key | Name |
|---|---|
| `restful-service` | RESTful Service |
| `web-frontend` | Web Frontend |

Types are shared by every company. A type marked as unavailable can't be chosen any more, but applications that already use it keep it. The Blueprint library will attach versioned scaffolds to each type.

## Applications

| Action | Route | Effect |
|---|---|---|
| Register | `POST /company/applications` | Records the application with its name, type and optional description |
| Edit | `PATCH /company/applications/:id` | Changes the name or description. The short name stays fixed. |
| Archive | `POST /company/applications/:id/archive` | Hides it from the list. Nothing is deleted. |
| Restore | `POST /company/applications/:id/restore` | Brings an archived application back |
| List | `GET /company/applications?status=active` | Active applications, or `archived` ones, sorted by name |
| Read | `GET /company/applications/:id` | One application |
| Types | `GET /company/application-types` | The types that can be registered now |

All routes start with `/api/v1`. Every company member can read. Registering, editing, archiving and restoring need `applications:create`, which Tech Leads and Company Admins have.

- **Short names:** each application gets a short name made from its name, such as `billing-api`, numbered if taken. It's fixed, because it will name the application's repository.
- **Names:** unique in the company, ignoring case. Archived applications keep their names, so a name always points to one application.
- **Repositories:** registering doesn't create one yet. Source Governance will create each application's repository, branches and protection.
- **History:** each change is recorded in the audit log as `ApplicationRegistered`, `ApplicationUpdated`, `ApplicationArchived` or `ApplicationRestored`. Saving without a change records nothing. Company Admins can choose to be notified of each.

## Data separation

Applications are company data. Row-level security limits every query to the current company, so another company's application can't be read or changed, even by ID. Names of the people who registered applications are read through a database function, because the app's database role can't read the user table.
