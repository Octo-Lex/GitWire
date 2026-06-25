#!/bin/sh
set -eu

# GitWire Validator Entrypoint — v0.23.0
#
# Merges the executor-provided patched files onto the baseline GitWire repo,
# then execs the requested command (e.g. "npm run lint --").
#
# The executor-service bind-mounts the patched-file tempdir at /workspace.
# The baseline repo is baked into /opt/gitwire-base at image build time.
# This entrypoint merges them in-place:
#
#   1. Move executor-provided files to a staging dir inside /workspace.
#   2. Copy baseline repo from /opt/gitwire-base into /workspace.
#   3. Overlay the staged patched files back onto /workspace.
#   4. Clean up staging dir.
#   5. exec the command.

cd /workspace

PATCH_DIR="/workspace/.gitwire-patch"

# Clean up any leftover staging dir from a previous run (shouldn't happen
# with --rm, but be safe).
rm -rf "$PATCH_DIR"
mkdir -p "$PATCH_DIR"

# 1. Preserve executor-provided patched files before seeding baseline.
# Move everything except the staging dir itself.
find /workspace -mindepth 1 -maxdepth 1 ! -name ".gitwire-patch" \
  -exec mv {} "$PATCH_DIR"/ \;

# 2. Seed full baseline repo from the image.
cp -a /opt/gitwire-base/. /workspace/

# 3. Overlay patched files onto the baseline.
# cp -a preserves permissions; errors on identical files are expected
# (the patched version wins). Use -f to force overwrite.
if [ -d "$PATCH_DIR" ] && [ "$(ls -A "$PATCH_DIR" 2>/dev/null)" ]; then
  cp -af "$PATCH_DIR"/. /workspace/
fi

# 4. Clean up staging.
rm -rf "$PATCH_DIR"

# 5. Ensure npm cache dir exists under the writable workspace.
mkdir -p /workspace/.npm-cache

# 6. exec the requested command (npm run lint -- / npm test -- / etc.)
exec "$@"
