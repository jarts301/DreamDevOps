-- Up Migration

-- One permission per thing people do with an application, so each role can be given
-- exactly what it needs. Company Admins manage the catalog but, as with releases and
-- deployments, don't change how applications run.
INSERT INTO identity.role_permissions (role_key, permission) VALUES
  ('company-admin', 'applications:view'),
  ('company-admin', 'applications:update'),
  ('company-admin', 'applications:archive'),
  ('company-admin', 'applications:monitor'),
  ('tech-lead', 'applications:view'),
  ('tech-lead', 'applications:update'),
  ('tech-lead', 'applications:archive'),
  ('tech-lead', 'applications:configure'),
  ('tech-lead', 'applications:migrate'),
  ('tech-lead', 'applications:run'),
  ('tech-lead', 'applications:test'),
  ('tech-lead', 'applications:monitor'),
  ('developer', 'applications:view'),
  ('developer', 'applications:test'),
  ('developer', 'applications:monitor'),
  ('operator', 'applications:view'),
  ('operator', 'applications:configure'),
  ('operator', 'applications:migrate'),
  ('operator', 'applications:run'),
  ('operator', 'applications:monitor'),
  ('viewer', 'applications:view'),
  ('viewer', 'applications:monitor');

-- Down Migration

DELETE FROM identity.role_permissions
WHERE permission IN (
  'applications:view',
  'applications:update',
  'applications:archive',
  'applications:configure',
  'applications:migrate',
  'applications:run',
  'applications:test',
  'applications:monitor'
);
