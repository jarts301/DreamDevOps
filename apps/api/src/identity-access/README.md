# Identity and Access

Knows who users are, which companies they belong to and what they can do. Keycloak handles login, and everything about access inside a company is stored here.

## Roles

Each user has one role per company. Roles and their permissions are stored as data, in `identity.roles` and `identity.role_permissions`, so companies can add custom roles later.

| Action | Permission | Company Admin | Tech Lead | Developer | Operator | Viewer |
|---|---|---|---|---|---|---|
| Manage company users and roles | `company-users:manage` | Yes | | | | |
| Connect deployment targets | `targets:connect` | Yes | | | Yes | |
| Register and manage applications | `applications:create` | Yes | Yes | | | |
| Push code and open PRs | `code:push` | | Yes | Yes | | |
| Approve PRs into develop or main | `pull-requests:approve` | | Yes | | | |
| Start releases and hotfixes | `releases:start` | | Yes | | | |
| Build feature test images | `feature-images:build` | | Yes | Yes | | |
| Deploy to test and roll back | `deployments-test:run` | | Yes | Yes | Yes | |
| Deploy to production and roll back | `deployments-production:run` | | Yes | | Yes | |
| View dashboards and logs | `dashboards:view` | Yes | Yes | Yes | Yes | Yes |
| Read the audit log | `audit:read` | Yes | | | | |
| Manage chat notifications | `notifications:manage` | Yes | | | | |

**Platform Admin** comes from the `platform-admin` realm role in Keycloak, not from a company. It grants `companies:manage`, `audit:read-own` and `editions:manage`, and no access to company data.

## How a company gets its people

1. A Platform Admin invites the first admin with `POST /platform/companies/:companyId/first-admin-invitation`. This only works while the company has no members.
2. The person signs in or registers through Keycloak, then calls `POST /invitations/accept` with the token. Accepting needs both the token and a matching signed-in email address.
3. The Company Admin invites everyone else with `POST /company/invitations`.

Invitations last 7 days and work once. The token is returned once, to the person who created the invitation, and only its hash is stored. It's also emailed to the invited address.

## Routes

All routes start with `/api/v1`. The company routes act on the signed-in user's current company.

| Route | Who | Purpose |
|---|---|---|
| `GET /auth/me` | Signed in | Who you are, your current company and permissions |
| `POST /auth/active-company` | Signed in | Chooses which of your companies this session acts for |
| `POST /auth/logout` | Signed in | Ends the session, and returns `logoutUrl` to send the browser to |
| `POST /invitations/accept` | Signed in | Joins a company |
| `POST /platform/companies/:id/first-admin-invitation` | `companies:manage` | Invites a company's first admin |
| `GET /company/roles` | `company-users:manage` | Lists roles and their permissions |
| `GET /company/members` | `company-users:manage` | Lists members |
| `PATCH /company/members/:userId` | `company-users:manage` | Changes a member's role |
| `DELETE /company/members/:userId` | `company-users:manage` | Removes a member |
| `GET`, `POST /company/invitations` | `company-users:manage` | Lists or creates invitations |
| `DELETE /company/invitations/:id` | `company-users:manage` | Revokes an invitation |

## Rules it enforces

- **Changes apply at once:** permissions are read on every request, so a role change or removal takes effect on the member's next request.
- **A company keeps an admin:** the last Company Admin can't be removed or demoted, even if two admins act at the same moment.
- **Platform roles stay out of companies:** they can't be granted through an invitation or role change.
- **Company data stays apart:** row-level security limits memberships and invitations to the current company. The application role reaches users only through database functions.

## Events

Changes publish `UserInvited`, `RoleGranted`, `MemberRemoved` and `InvitationRevoked` through the outbox. Their payloads hold IDs and roles, not email addresses or tokens.
