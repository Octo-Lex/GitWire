# Triage Worker

AI-powered issue and pull request classification.

## Queue: `triage`

## Job Flow

1. Receive job with issue/PR data
2. Fetch issue details from database
3. Build Claude prompt with issue context
4. Call Anthropic API for classification
5. Parse response: type, priority, summary
6. Upsert triage fields in database
7. Apply labels on GitHub
8. Trigger duplicate detection (for issues)

## Claude Prompt

The worker constructs a structured prompt asking Claude to classify the issue. The prompt includes:
- Issue title
- Existing labels
- Repository context
- Classification categories (bug, feature, etc.)
- Priority levels (critical, high, medium, low)

## Duplicate Detection

After triage, the worker also:
1. Generates a 512-dim trigram hash embedding
2. Stores in `issue_embeddings`
3. Compares against all existing repo issues
4. Creates `duplicate_signals` for matches ≥ 0.82

## Error Handling

- API failures are retried up to 3 times
- Invalid Claude responses are logged and the job fails
- GitHub label application failures don't block the job

→ [CI Heal Worker](/workers/ci-heal-worker)
