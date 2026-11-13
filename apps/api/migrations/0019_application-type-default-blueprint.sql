-- Up Migration

-- Each type now starts from one of many blueprints, such as Express, FastAPI or Axum for a
-- service, and an application registered without choosing one starts from its type's
-- default. Until now the default was the type's first blueprint by key, which changes
-- whenever a blueprint with an earlier key is added, so it's kept here instead, as data,
-- as the types are. Blueprints are files, not rows, so there's no foreign key.
ALTER TABLE catalog.application_types
  ADD COLUMN default_blueprint text CHECK (default_blueprint ~ '^[a-z][a-z0-9-]{1,39}$');

-- The blueprints each type has started from so far.
UPDATE catalog.application_types SET default_blueprint = 'node-service' WHERE key = 'restful-service';
UPDATE catalog.application_types SET default_blueprint = 'angular-frontend' WHERE key = 'web-frontend';

-- Down Migration

ALTER TABLE catalog.application_types DROP COLUMN default_blueprint;
