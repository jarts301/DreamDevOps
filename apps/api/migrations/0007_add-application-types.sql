-- Up Migration

-- Each application is registered as one type from the Application Catalog, such as
-- "typescript-frontend". The catalog is code, so the database checks only the key's
-- shape. The application role may set it when creating an application, but not change
-- it, because it decides how the application is built and run. Applications registered
-- before types existed have none.
ALTER TABLE tenancy.applications
  ADD COLUMN type text CHECK (char_length(type) <= 60 AND type ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- Down Migration

ALTER TABLE tenancy.applications DROP COLUMN type;
