# File Scoring

How GitWire ranks repository files to determine which ones to fix.

## Scoring Criteria

During Pass 1 (Analysis), Claude returns a list of candidate files. Each file is scored based on:

### 1. Keyword Match

The issue title and labels are parsed for keywords. Files whose names or paths contain these keywords receive higher scores.

Example: Issue "Fix login crash on mobile" → keywords: `login`, `mobile`, `crash`
- `src/auth/login.ts` → high score (keyword `login` in path)
- `src/components/MobileHeader.tsx` → medium score (`mobile` in name)
- `src/utils/format.ts` → low score (no keyword match)

### 2. Proximity to Source

Files closer to the "source" of the reported issue are ranked higher:

| Proximity | Score Boost |
|-----------|-------------|
| Exact file mentioned in issue | +50 |
| Same directory as mentioned file | +20 |
| Same module/package | +10 |
| Same language as error | +5 |

### 3. Language Preference

Files matching the repository's primary language get a score boost. If a repo is primarily TypeScript, `.ts`/`.tsx` files score higher than `.js` or `.json`.

## Ranking

Files are sorted by total score (descending). Only the top N files (configurable, default 5) are fetched for Pass 2.

## File Fetch

After ranking, GitWire fetches the top files from GitHub via the Contents API. Files that fail to fetch (404, binary, too large) are skipped and the next file in the ranking is used.

→ [Pre-Merge Validation](/pillars/contributor/pre-merge-validation)
