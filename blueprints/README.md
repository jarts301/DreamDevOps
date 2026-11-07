# Blueprints

A blueprint is the starting point of every new application of one type. It holds the scaffold committed into the application's new repository: code, tests, linting, a Dockerfile, a Compose file and the standard pipeline.

| Blueprint | Application type | What it starts with |
|---|---|---|
| `node-service` | RESTful Service | TypeScript on Fastify and Node.js 24, with health checks and OpenTelemetry |
| `angular-frontend` | Web Frontend | Angular 22 served by nginx, with settings read at runtime |

Both scaffolds pin their base images by digest, install from a lockfile, and run as a non-root user with a read-only file system.

## Layout

Each version is a folder, `<key>/<version>/`, holding:

| Item | Purpose |
|---|---|
| `blueprint.json` | What the blueprint defines: its type, language, runtime profile, telemetry, pipeline and deployment strategies |
| `files/` | The scaffold, copied as it is into new repositories |

New applications always start from the newest version for their type. Each repository records the version it started from.

## Placeholders

Text files can use these, and the platform fills them in for each application. Any other `__APP_…__` name stops the API from starting.

| Placeholder | Replaced with | Use it in |
|---|---|---|
| `__APP_SLUG__` | The application's short name, such as `billing-api` | Package names, image names |
| `__APP_NAME__` | The name as entered | Markdown |
| `__APP_NAME_HTML__` | The name, escaped for HTML | HTML |
| `__APP_NAME_JSON__` | The name as a quoted JSON string | JSON, JavaScript and TypeScript |

## Publishing a version

A published version never changes, because applications already started from it. `published.json` records a checksum of each version, and the API refuses to start if a published version changed or a version isn't published.

To change a blueprint, copy its newest folder to a new version number, change the copy, update `version` in its `blueprint.json`, and then publish it:

```bash
npm run blueprints:publish
```

Then check that every version still produces a working project. This installs, lints, tests and builds each scaffold, and runs its image until the health check passes. It needs Docker and the internet, and takes a few minutes:

```bash
npm run test:scaffolds
```

Line endings are always LF, set in `.gitattributes`, so checksums match on every operating system.
