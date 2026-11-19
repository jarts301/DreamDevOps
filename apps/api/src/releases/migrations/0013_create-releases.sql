-- Up Migration

CREATE SCHEMA releases;

-- Each release or hotfix of an application, from its branch being cut to its final image.
CREATE TABLE releases.releases (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  application_id uuid NOT NULL REFERENCES catalog.applications (id),
  kind text NOT NULL CHECK (kind IN ('release', 'hotfix')),
  version text NOT NULL CHECK (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  branch text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'merged', 'published')),
  candidates integer NOT NULL DEFAULT 0,
  last_candidate_commit text,
  merge_commit text,
  merge_back_pull_request integer,
  final_build_id uuid,
  started_by uuid REFERENCES identity.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  merged_at timestamptz,
  published_at timestamptz,
  UNIQUE (application_id, version)
);

-- Git Flow allows one open release and one open hotfix per application at a time.
CREATE UNIQUE INDEX releases_one_open_per_kind ON releases.releases (application_id, kind) WHERE status = 'open';

-- Each release candidate: a commit on the release branch, its vX.Y.Z-rc.N tag and its image build.
CREATE TABLE releases.candidates (
  release_id uuid NOT NULL REFERENCES releases.releases (id),
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  number integer NOT NULL,
  commit_sha text NOT NULL,
  tag text NOT NULL,
  build_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (release_id, number),
  UNIQUE (release_id, commit_sha)
);

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['releases', 'candidates'] LOOP
    EXECUTE format('ALTER TABLE releases.%I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE releases.%I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format(
      'CREATE POLICY %I ON releases.%I TO dreamdevops_app
         USING (company_id = kernel.current_company_id())
         WITH CHECK (company_id = kernel.current_company_id())',
      name || '_company_isolation', name);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA releases TO dreamdevops_app;
GRANT SELECT, INSERT,
  UPDATE (status, candidates, last_candidate_commit, merge_commit, merge_back_pull_request, final_build_id,
          updated_at, merged_at, published_at)
  ON releases.releases TO dreamdevops_app;
GRANT SELECT, INSERT, UPDATE (build_id) ON releases.candidates TO dreamdevops_app;

-- Down Migration

DROP SCHEMA releases CASCADE;
