# Fix Tables

4 tables for autonomous code fixes, CI healing, and duplicate detection.

## fix_attempts

Autonomous contributor fix attempt records.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT FK → repositories | Target repo |
| `issue_number` | INT | GitHub issue number |
| `branch_name` | TEXT | Created branch name |
| `pr_number` | INT | Opened PR number |
| `status` | TEXT | `pending` → `analyzing` → `generating` → `submitted` / `failed` / `rejected` |
| `complexity` | TEXT | `trivial`, `simple`, `moderate`, `complex` |
| `explanation` | TEXT | Claude's fix explanation |
| `error` | TEXT | Error if failed |

## heal_prs

Auto-generated CI healing PRs.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `ci_run_id` | BIGINT FK → ci_runs | Parent CI run |
| `repo_id` | BIGINT FK → repositories | Target repo |
| `github_pr_number` | INT | PR number on GitHub |
| `github_pr_url` | TEXT | PR URL |
| `heal_branch` | TEXT | Branch name (`gitwire/heal/{runId}`) |
| `failure_type` | TEXT | One of 9 failure type categories |
| `files_changed` | TEXT[] | Modified file paths |
| `pr_title` | TEXT | PR title |
| `status` | TEXT | `open`, `merged`, `closed` |

## issue_embeddings

512-dimensional trigram hash vectors for duplicate detection.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `issue_id` | BIGINT UNIQUE FK → issues | Parent issue |
| `repo_id` | BIGINT FK → repositories | Parent repo |
| `embedding` | REAL[] | 512-dim float vector |
| `embedded_text` | TEXT | Text that was embedded |
| `model` | TEXT | `trigram-hash` (or `voyage-3-lite` legacy) |

## duplicate_signals

Pairwise similarity records between issues.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `source_issue_id` | BIGINT FK → issues | Newer issue |
| `target_issue_id` | BIGINT FK → issues | Potential duplicate of |
| `repo_id` | BIGINT FK → repositories | Repository |
| `similarity` | REAL | Cosine similarity (0.0–1.0) |
| `status` | TEXT | `pending`, `confirmed`, `dismissed` |
| `comment_id` | BIGINT | GitHub comment ID posted on issue |

→ [Enforcement Tables](/database/enforcement-tables)
