# Org-Level Config

Four-layer config resolution: defaults → org → repo → DB overrides.

## Resolution Chain

When GitWire resolves configuration for a repository, it merges four layers (highest priority wins):

```
1. DEFAULT_CONFIG        (from @gitwire/rules — hardcoded defaults)
2. Org .gitwire.yml      (from {org}/gitwire-config repo)
3. Repo .gitwire.yml     (from the repository itself)
4. DB overrides          (set via dashboard UI)
```

## Org Config Repo

Create a repository named `gitwire-config` (configurable via `GITWIRE_ORG_CONFIG_REPO` env var) in your GitHub organization. Place `.gitwire.yml` at the root or `.github/.gitwire.yml`.

### Example

Organization `AcmeCorp` creates `AcmeCorp/gitwire-config` with:

```yaml
# AcmeCorp/gitwire-config/.gitwire.yml
version: 1
pillars:
  ci_healing:
    enabled: true
    triggers:
      branches: ["main", "develop"]
  triage:
    triggers:
      ignore_authors: ["*[bot]"]
  ai_review:
    enabled: true
```

This config applies to **every** repo in the organization, unless overridden by the repo's own `.gitwire.yml`.

## Layer Metadata

The resolved config includes `_meta.layers` showing which layers were active:

```json
{
  "_meta": {
    "layers": {
      "defaults": true,
      "org": true,
      "repo": false,
      "db": false
    },
    "org_source": "AcmeCorp/gitwire-config",
    "resolved_at": "2026-05-23T18:00:00Z"
  }
}
```

## Environment Variable

Override the default org config repo name:

```
GITWIRE_ORG_CONFIG_REPO=my-org-config
```

## Caching

Resolved configs are cached in Redis for 5 minutes (`CACHE_TTL = 300`). Changes to org or repo `.gitwire.yml` files may take up to 5 minutes to propagate.

## Fallback Behavior

- If the org config repo doesn't exist → skip org layer (normal)
- If the org config repo is private → requires the GitHub App to be installed on the org
- If `.gitwire.yml` is malformed → skip that layer, log a warning
