# Release Management

Runs Git Flow releases and hotfixes, from cutting the branch to the final image.

## A release, step by step

1. A Tech Lead starts a release from `develop`, or a hotfix from `main`, on the application's page. Only one release and one hotfix can be open at a time. See [Versions](#versions).
2. The platform cuts `release/x.y.z` or `hotfix/x.y.z`, and opens its pull request into `main`.
3. Each new commit on that branch becomes a release candidate: the platform tags it `vx.y.z-rc.N` and builds an RC image. It reports the `dreamdevops/rc-image` status on the commit: pending, then success or failure.
4. Fixes reach the branch by pull request, which makes a new candidate.
5. The pull request into `main` can merge once a Tech Lead approves it, the tests pass, and its newest commit has a published RC image.
6. When it merges, the platform tags the merge commit `vx.y.z`, builds the final image with the release key, and opens a pull request from `main` back into `develop`, so release fixes aren't lost.
7. The release is published when its final image passes every check.

Forgejo enforces the rules on the server. Only the platform creates release branches and version tags.

## Missed webhooks

Forgejo doesn't send a webhook again when the platform missed it, such as while the API was stopped. So the platform catches up: for each open release, a pull request into `main` that merged finishes the release (step 6), and a newer commit on its branch becomes a candidate. This runs every 5 minutes for every company, and when someone opens the application's page. Doing it twice changes nothing.

## Versions

- **Unused, and higher than everything merged:** a new version must be higher than every merged or published one.
- **A hotfix goes out first:** while a release is open, a hotfix must be lower than it. If `1.3.0` is open after `1.2.0`, the hotfix is `1.2.1`.
- **A release goes out after:** while a hotfix is open, a release must be higher than it.

The application's page suggests the next release from the newest version, open ones included, and the next hotfix from the newest merged one.

## Routes

All routes start with `/api/v1`.

| Route | Who | Purpose |
|---|---|---|
| `GET /company/applications/:id/releases` | Any member | Releases with their candidates, and suggested next versions |
| `POST /company/applications/:id/releases` | `releases:start` | Starts `{ "kind": "release" \| "hotfix", "version": "1.4.0" }` |
| `POST /company/applications/:id/releases/sync` | Any member | Catches up on merges and pushes the platform missed, and returns `{ "moved": n }` |
| `POST /company/releases/:id/final-build` | `releases:start` | Builds a failed final image again |

## Events

`ReleaseStarted`, `ReleaseCandidateCreated`, `ReleaseMerged` and `ReleasePublished` are recorded in the audit log. Company Admins can be notified of releases starting, merging and being published, and of failed builds.

## Not done yet

- **Abandoning a release:** an open release can't be cancelled from the dashboard yet.
- **Hotfixes during a release:** a hotfix merges back into `develop`, but not into an open release branch.
- **The pull request's source:** Forgejo can't limit which branch a pull request into `main` comes from, so the RC image check is what keeps other branches out.
