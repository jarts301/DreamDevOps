// Applies the migrations in migrations/ to DATABASE_URL. Without one, there's nothing to do.
import { runner } from 'node-pg-migrate';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === '') {
  console.log("DATABASE_URL isn't set, so there's no database to migrate.");
  process.exit(0);
}

const applied = await runner({
  databaseUrl,
  dir: 'migrations',
  direction: 'up',
  migrationsTable: 'pgmigrations',
  log: () => {},
});
console.log(
  applied.length === 0
    ? 'The database is up to date.'
    : `Applied ${applied.map((migration) => migration.name).join(', ')}.`,
);
