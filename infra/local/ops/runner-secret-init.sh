#!/bin/sh
# Makes the secrets the local CI runners use to connect to Forgejo, once. They stay in a
# volume that only Forgejo's setup and the runners mount. Safe to run repeatedly.
set -eu

for name in secret image-secret; do
  file="/runner-secret/$name"
  if [ -s "$file" ]; then
    echo "The runner $name already exists."
  else
    od -An -tx1 -N20 /dev/urandom | tr -d ' \n' > "$file"
    echo "The runner $name was created."
  fi
  # Forgejo's setup runs as user 1000, and needs to read it.
  chown 1000:1000 "$file"
  chmod 400 "$file"
done
