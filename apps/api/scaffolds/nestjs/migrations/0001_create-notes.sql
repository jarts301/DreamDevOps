-- Up Migration

-- An example table, for the notes resource. Replace both with your own.
CREATE TABLE notes (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE notes;
