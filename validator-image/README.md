# GitWire Validator Image (v0.23.0)

The proof-bearing validation runtime for the executor-service. This image runs
`lint`, `test`, and `build` against a merged workspace (baseline GitWire repo +
executor-provided patched files) under strict isolation.

## Isolation contract

The executor-service runs this image with:

```
--network=none --read-only --user=1000:1000
--memory=<limit> --pids-limit=<limit>
--tmpfs=/tmp:rw,size=<bounded>
--workdir=/workspace
--volume=<patched-workspace>:/workspace:rw
```

The image is compatible with all of these constraints:
- Non-root (uid 1000) can execute node/npm and project tools
- No command needs root, network, or writes outside `/workspace` or `/tmp`
- `HOME` and `NPM_CONFIG_CACHE` are redirected to `/workspace`
- Dependencies are installed at image build time (`npm ci`)
- The entrypoint merges baseline + patched files in-place in `/workspace`

## Workspace merge strategy

The executor bind-mounts patched files at `/workspace`. The baseline repo is
baked into `/opt/gitwire-base`. The entrypoint:

1. Moves executor-provided files to `/workspace/.gitwire-patch` (staging)
2. Copies baseline from `/opt/gitwire-base/.` into `/workspace/`
3. Overlays staged patched files back onto `/workspace/`
4. Removes the staging dir
5. Executes the requested command from `/workspace/`

This avoids the `/tmp` capacity trap (tmpfs defaults to ~1 MB from
`limits.output_bytes`).

## Proof command set

v0.23.0 supports these command IDs only:

| Command | Script | Notes |
|---------|--------|-------|
| `lint` | `npm run lint --` | ✅ Supported |
| `test` | `npm test --` | ✅ Supported |
| `build` | `npm run build --` | ✅ Supported |
| `typecheck` | `npm run typecheck --` | ❌ Not supported (no root script exists) |

**Do not add a fake `typecheck` script.** A no-op would create false evidence.
If `typecheck` is needed in the future, add a real script with a real target.

## Local build

```bash
# Build from the repo root (the Dockerfile expects repo-root context).
docker build -t gitwire-validator:local \
  -f validator-image/Dockerfile .
```

## GHCR publish (for production)

```bash
# Tag the image for GHCR.
IMAGE="ghcr.io/<org>/gitwire-validator:v0.23.0"

# Build from the intended release commit.
git checkout v0.23.0
docker build -t "$IMAGE" -f validator-image/Dockerfile .

# Push to GHCR (requires docker login ghcr.io).
docker push "$IMAGE"

# Capture the immutable digest.
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE" | sed 's/.*@//')
echo "GITWIRE_VALIDATOR_IMAGE_REF=$IMAGE@$DIGEST"
echo "GITWIRE_VALIDATOR_IMAGE_DIGEST=$DIGEST"
```

## CT 115 pull + inspect verification

```bash
ssh gitwire

# Pull the digest-pinned image.
GITWIRE_VALIDATOR_IMAGE_REF="ghcr.io/<org>/gitwire-validator@sha256:<digest>"
docker pull "$GITWIRE_VALIDATOR_IMAGE_REF"

# Verify RepoDigests contains the configured digest.
docker inspect --format '{{json .RepoDigests}}' "$GITWIRE_VALIDATOR_IMAGE_REF"
# Must contain: "ghcr.io/<org>/gitwire-validator@sha256:<digest>"

# Verify the digest matches GITWIRE_VALIDATOR_IMAGE_DIGEST.
docker inspect --format '{{json .RepoDigests}}' "$GITWIRE_VALIDATOR_IMAGE_REF" | \
  grep -q "sha256:<digest>" && echo "Digest verified" || echo "DIGEST MISMATCH"
```

## Isolation-contract smoke test

Run the image locally under the same isolation flags the executor uses:

```bash
# Create a minimal patched workspace (a package.json that passes lint).
mkdir -p /tmp/test-workspace
echo '{"name":"test","scripts":{"lint":"echo lint-pass","test":"echo test-pass","build":"echo build-pass"}}' \
  > /tmp/test-workspace/package.json

docker run --rm \
  --network=none \
  --read-only \
  --user=1000:1000 \
  --memory=256m \
  --pids-limit=64 \
  --tmpfs=/tmp:rw,size=16m \
  --workdir=/workspace \
  --volume=/tmp/test-workspace:/workspace:rw \
  gitwire-validator:local \
  npm run lint --

# Expected: "lint-pass"
```

## Production configuration values

After building and pushing, configure both `gitwire-app` and
`gitwire-executor-service` (via project-root `.env` or shell):

```
GITWIRE_VALIDATOR_IMAGE_REF=ghcr.io/<org>/gitwire-validator@sha256:<64-hex>
GITWIRE_VALIDATOR_IMAGE_DIGEST=sha256:<64-hex>
```

Both values MUST be set identically in both services. The executor-service
inspects the image and verifies the configured digest appears in `RepoDigests`.

## Known limitations (v0.23.0)

- `typecheck` is not supported — no root script exists
- Production CI-evidence envelope uses `policy_scope_check` and
  `test_or_build_result` (semantic IDs), not the executor's allowlisted
  command IDs (`lint`/`test`/`build`). Task 9 reconciles this.
- The image must be rebuilt and re-published for each release commit
- No automated image lifecycle management (planned: Task 12)
