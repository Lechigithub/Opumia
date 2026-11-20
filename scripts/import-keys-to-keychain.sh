#!/bin/zsh
# One-time move of API keys from the plain-text file ~/.opumia_keys into macOS Keychain.
#
# RUN THIS YOURSELF in macOS Terminal (not inside the Claude app):
#   zsh ~/Opumia/scripts/import-keys-to-keychain.sh
#
# - Each key becomes a Keychain item: service "opumia", account = variable name.
# - Values go to Keychain over stdin, so they never appear on a command line or on screen.
# - Prints key NAMES only. Re-running is safe (existing items are updated).
# - Does NOT delete ~/.opumia_keys. Delete it yourself after `pnpm opumia keys` shows keychain=all.
set -eu

SRC="${OPUMIA_KEYS_FILE:-$HOME/.opumia_keys}"
SERVICE="${OPUMIA_KEYCHAIN_SERVICE:-opumia}"   # override only for testing

[[ -f "$SRC" ]] || { echo "No keys file at $SRC — nothing to import."; exit 1; }

added=0; skipped=0
cmds=""
names=()
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ '^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$' ]] || continue
  name="${match[2]}"
  val="${match[3]}"
  val="${val## }"; val="${val%% }"
  if [[ "$val" == \"*\" || "$val" == \'*\' ]]; then val="${val:1:-1}"; fi
  if [[ -z "$val" ]]; then
    echo "  - $name (empty, skipped)"; skipped=$((skipped+1)); continue
  fi
  if [[ "$val" == *\"* || "$val" == *\\* ]]; then
    echo "  ! $name has a \" or \\ in it — add it by hand: security add-generic-password -U -s $SERVICE -a $name -w"
    skipped=$((skipped+1)); continue
  fi
  cmds+="add-generic-password -U -s $SERVICE -a $name -w \"$val\""$'\n'
  names+=("$name")
done < "$SRC"
unset val

if (( ${#names} > 0 )); then
  print -rn -- "$cmds" | /usr/bin/security -i >/dev/null 2>&1 || true
fi
unset cmds

# Verify each item exists (checks presence only; does not read the value).
for name in "${names[@]}"; do
  if /usr/bin/security find-generic-password -s "$SERVICE" -a "$name" >/dev/null 2>&1; then
    echo "  ✓ $name"; added=$((added+1))
  else
    echo "  ✗ $name (not stored — add by hand: security add-generic-password -U -s $SERVICE -a $name -w)"
    skipped=$((skipped+1))
  fi
done

echo "Imported $added key(s) into Keychain (service \"$SERVICE\"), skipped $skipped."
echo "Next: cd ~/Opumia && pnpm opumia keys     (should say keychain=$added)"
echo "Then delete the plain-text file:  rm ~/.opumia_keys"
