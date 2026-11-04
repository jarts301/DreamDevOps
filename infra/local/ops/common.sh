#!/bin/sh
# Picks the backup folder to use: BACKUP_NAME if set, otherwise the newest one.

select_backup() {
  if [ -n "${BACKUP_NAME:-}" ]; then
    selected="$BACKUP_NAME"
  else
    selected=$(ls -1 /backups 2>/dev/null | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort | tail -n 1 || true)
  fi

  case "$selected" in
    "" )
      echo "No backup found. Run the backup service first." >&2
      exit 1
      ;;
    */* | .* )
      echo "Invalid backup name: $selected" >&2
      exit 1
      ;;
  esac

  for file in keycloak.dump forgejo.dump forgejo-data.tar.gz; do
    if [ ! -s "/backups/$selected/$file" ]; then
      echo "Backup $selected is missing $file." >&2
      exit 1
    fi
  done

  echo "$selected"
}
