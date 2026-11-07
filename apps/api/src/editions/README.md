# Editions and Entitlements

Says which features each company has. Every company starts on the free Community Edition, which turns on every Community feature.

## Editions

| Edition | What it includes |
|---|---|
| Community | Every Community feature, always. Nothing can turn these off. |
| Commercial | The Community features, plus the commercial features the installed commercial code grants |

Platform admins with `editions:manage` set each company's edition. Each change is recorded in the company's audit log as `CompanyEditionChanged`, and setting the edition a company already has changes nothing.

A company can only move to the Commercial Edition when the commercial code is installed on the server. Without it, the API refuses with `409`.

## Features

The catalog in `domain/features.ts` lists every feature, planned ones included, and the edition that includes it. Routes and screens refer to features by key, so a key must never change.

| Rule | Why |
|---|---|
| Community features are always on | A provider can't take them away, so a free installation keeps everything it had |
| Commercial features are on only for a Commercial company | A faulty provider can't give them to a Community company |
| Unknown keys from a provider are ignored | Only catalog features can be turned on |
| If the provider fails, commercial features are off | Access fails closed |

## Extension point

This repository includes only the `CommunityEntitlementProvider`, which has no commercial features to offer. The Commercial Edition lives in a separate, private repository. It passes its own `EntitlementProvider` to `AppModule.forRoot({ entitlementProvider })`, and that provider checks its license. The license check never lives in this repository.

A provider answers two questions:

- `status()`: whether commercial features are installed and licensed, with a name and detail for platform admins.
- `commercialFeatures(company)`: which commercial features a Commercial company has.

## Protecting a route

Add `@RequireFeature('feature-key')` next to the route's access rule. The access rule still decides who in the company may call it. The feature check runs after it, and refuses with `403` and a message when the company's edition doesn't include the feature. A key that isn't in the catalog fails when the app starts.

The dashboard hides what a company can't use, for convenience only. The API checks every request.

## Routes

All routes start with `/api/v1`.

| Route | Who | Purpose |
|---|---|---|
| `GET /company/entitlements` | Any company member | The company's edition, and every feature with whether it's on |
| `GET /platform/editions` | `editions:manage` | Every company's edition, and whether commercial features are installed |
| `PUT /platform/editions/:companyId` | `editions:manage` | Sets a company's edition: `{ "edition": "community" }` or `"commercial"` |
