# Chunk Hash + IgnoreManager Enhancement Plan

## TL;DR

> **Quick Summary**: Add per-chunk content hashing (SHA-256) to skip re-embedding unchanged chunks, fix IgnoreManager negation pattern bug, and consolidate CLI's duplicate ignore code.
>
> **Deliverables**:
> - `chunkHash: string` field on `CodeChunk` + DB column
> - Incremental re-indexing: only embed chunks whose hash changed
> - Watch handler hash check before re-indexing
> - Orphan chunk cleanup on file change
> - Fixed `!pattern` negation in `IgnoreManager.addGitignoreRules()`
> - CLI `code-index.js` using `IgnoreManager` instead of duplicate code
>
> **Estimated Effort**: Short (1-2 days)
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4

---

## Context

### Original Request
Add `compute_chunk_hash()` for incremental indexing (skip re-embedding unchanged chunks) and enhance IgnoreManager (hierarchical .gitignore loading).

### Interview Decisions
- **Chunk hashing**: Skip re-embedding unchanged chunks — compute per-chunk SHA-256, compare vs stored, only embed new/changed
- **Hash algorithm**: SHA-256 (consistent with existing file hashing, no new dependency)
- **IgnoreManager scope**: Fix negation patterns + CLI dedup (hierarchical .gitignore ALREADY WORKS)
- **.codeignore**: NOT needed
- **Tests**: No automated tests, agent QA only

### Research Findings
- **No chunk-level hashing exists** — only file-level SHA-256
- When file changes: re-chunk ALL + re-embed ALL + `db.add()` (append-only, creates duplicates)
- `db.upsertChunks()` = LanceDB `add()` — NOT keyed upsert, just appends
- `db.removeByPath()` exists but NOT called during re-indexing → orphan chunks accumulate
- Watch handler (`engine.ts:296-308`) has **NO hash check** — blindly re-chunks + re-embeds
- `IgnoreManager.addGitignoreRules()` strips `#` comments but never handles `!` negation — they get added as regular patterns
- CLI `code-index.js` has its own duplicate `createIgnoreManager()` that doesn't use IgnoreManager class
- `ignore` npm package DOES support negation natively — just need to pass `!` patterns correctly

### Metis Review
**Identified Gaps** (addressed):
- Migration strategy: existing chunks without chunkHash → re-embed once on first change, then use hashing (no explicit backfill task needed)
- Atomicity: hash + embed + store as logical unit — if embed fails, chunk won't have hash stored, so next run retries
- Orphan lifecycle: MUST call `removeByPath()` before re-inserting chunks for a changed file
- Watch idempotency: file watcher already debounced (300ms), but add hash check as safety net
- Chunk boundary shifts: when file changes, chunk boundaries may shift → different chunk content → different hash → correctly re-embedded (this is the right behavior, not a bug)

---

## Work Objectives

### Core Objective
Stop re-embedding unchanged chunks and fix two IgnoreManager bugs.

### Concrete Deliverables
- `chunkHash` field on `CodeChunk` interface + DB column
- `computeChunkHash()` utility using SHA-256
- Incremental indexing: remove old chunks for path → compute new chunk hashes → only embed chunks with new/changed hashes
- Watch handler checks file hash before re-indexing
- `addGitignoreRules()` correctly handles `!` negation patterns
- CLI `code-index.js` imports and uses `IgnoreManager` class

### Definition of Done
- [ ] Editing 1 line in a 500-line file re-embeds only affected chunks (not all 10+)
- [ ] `!important-file.js` in `.gitignore` correctly un-ignores the file
- [ ] CLI `code-index.js` has zero duplicate ignore logic
- [ ] Watch handler skips re-indexing when file hash unchanged
- [ ] `tsc --noEmit` passes with zero errors

### Must Have
- Per-chunk SHA-256 content hash computed after chunking
- `chunkHash` stored in DB alongside chunk data
- Only chunks with changed hashes get re-embedded
- `removeByPath()` called before re-inserting for changed files (no orphan accumulation)
- Watch handler checks file hash before processing change events
- `addGitignoreRules()` passes `!` prefixed patterns correctly to `ignore` library
- CLI `code-index.js` uses `IgnoreManager` class

### Must NOT Have (Guardrails)
- Do NOT change embedding model or vector dimensions
- Do NOT add blake3 or new hash dependencies
- Do NOT add `.codeignore` file support
- Do NOT add content-similarity-based chunk reuse (only exact hash match)
- Do NOT add chunk-level delete API beyond `removeByPath(path)`
- Do NOT add background orphan cleanup job
- Do NOT add hash computation caching layer
- Do NOT change initial bulk indexing flow (only watch/re-index incremental)
- Do NOT add automated tests

---

## Verification Strategy

### Test Decision
- **Infrastructure exists**: YES (vitest)
- **Automated tests**: NO (user declined)
- **Framework**: vitest (available but not used)

### QA Policy
Every task includes agent-executed QA scenarios. Evidence saved to `.sisyphus/evidence/`.

- **Library/Module**: Use Bash (node REPL) — import modules, call functions, compare output

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation):
├── Task 1: Add chunkHash to CodeChunk type + DB schema [quick]
├── Task 2: Compute chunkHash utility + wire into chunking [quick]
└── Task 3: Fix IgnoreManager negation patterns [quick]

Wave 2 (Integration):
├── Task 4: Incremental indexing — skip re-embedding unchanged chunks (depends: 1, 2) [deep]
├── Task 5: Watch handler hash check + orphan cleanup (depends: 1, 4) [unspecified-high]
└── Task 6: Consolidate CLI code-index.js to use IgnoreManager (depends: 3) [quick]

Wave FINAL:
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay
```

### Dependency Matrix

- **1**: - → 2, 4, 5
- **2**: 1 → 4
- **3**: - → 6
- **4**: 1, 2 → 5
- **5**: 1, 4 → F1-F4
- **6**: 3 → F1-F4

### Agent Dispatch Summary

- **Wave 1**: **3** — T1 `quick`, T2 `quick`, T3 `quick`
- **Wave 2**: **3** — T4 `deep`, T5 `unspecified-high`, T6 `quick`
- **FINAL**: **4** — F1 `oracle`, F2 `unspecified-high`, F3 `unspecified-high`, F4 `deep`

---

## TODOs

- [x] 1. Add `chunkHash` to CodeChunk type + DB schema

  **What to do**:
  - In `packages/code-search/src/types.ts`:
    - Add `chunkHash?: string` field to `CodeChunk` interface (after `fileHash`)
  - In `packages/code-search/src/db/database.ts`:
    - Add `chunkHash` column to the chunk record mapping in `upsertChunks()` — store `chunk.chunkHash` alongside existing fields
    - Add `chunkHash` to the select fields in `search()` and `getIndexedFileHashes()` (or create new `getIndexedChunkHashes()` method)
    - Create new method `getChunksByPath(path: string, projectPath: string): Promise<Map<string, string>>` — returns `Map<chunkHash, chunkId>` for all chunks belonging to a given filePath. This is needed for incremental diffing.
  - Verify `tsc --noEmit` passes

  **Must NOT do**:
  - Do NOT remove `fileHash` field — it's still used for file-level skip logic
  - Do NOT add blake3 or new dependencies
  - Do NOT change vector dimensions or embedding model

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 2, 3)
  - **Blocks**: Tasks 4, 5

  **References**:

  **Pattern References** (existing code to follow):
  - `packages/code-search/src/types.ts:15` — Current `fileHash?: string` field. Add `chunkHash?: string` right after.
  - `packages/code-search/src/db/database.ts:241-270` — Current `upsertChunks()` mapping. Add `chunkHash` column alongside existing fields.
  - `packages/code-search/src/db/database.ts:317-335` — Current `getIndexedFileHashes()`. Use as pattern for new `getChunksByPath()`.

  **API/Type References**:
  - `packages/code-search/src/types.ts:3-20` — Full `CodeChunk` interface.

  **Acceptance Criteria**:
  - [ ] `CodeChunk` interface has `chunkHash?: string` field
  - [ ] `database.ts` stores `chunkHash` in chunk records
  - [ ] `getChunksByPath()` method exists and returns `Map<chunkHash, chunkId>`
  - [ ] `tsc --noEmit` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: chunkHash field exists on CodeChunk type
    Tool: Bash (grep)
    Preconditions: pnpm build completed
    Steps:
      1. grep -n "chunkHash" packages/code-search/dist/types.d.ts
      2. Assert output contains "chunkHash"
    Expected Result: chunkHash field present in type definition
    Failure Indicators: No match found
    Evidence: .sisyphus/evidence/task-1-chunk-hash-type.txt

  Scenario: DB stores chunkHash column
    Tool: Bash (grep)
    Preconditions: pnpm build completed
    Steps:
      1. grep -n "chunkHash" packages/code-search/dist/db/database.js
      2. Assert output contains "chunkHash"
    Expected Result: chunkHash stored in DB records
    Failure Indicators: No match found
    Evidence: .sisyphus/evidence/task-1-chunk-hash-db.txt
  ```

  **Commit**: YES (with Tasks 2, 4, 5)
  - Message: `feat(code-search): add chunk content hashing for incremental indexing`
  - Files: `types.ts`, `database.ts`

- [x] 2. Compute chunkHash utility + wire into chunking

  **What to do**:
  - In `packages/code-search/src/chunker/`:
    - Add `computeChunkHash(content: string): string` function — `createHash('sha256').update(content).digest('hex')`
    - Place in a new utility or in `chunk-manager.ts` directly
  - In `packages/code-search/src/chunker/chunk-manager.ts`:
    - After chunking, compute `chunkHash = computeChunkHash(chunk.content)` for each chunk
    - Assign `chunk.chunkHash = chunkHash` before returning chunks
    - Apply in both `chunkWithChonkie()` and wherever chunks are created
  - Verify `tsc --noEmit` passes

  **Must NOT do**:
  - Do NOT use blake3 — SHA-256 only
  - Do NOT hash metadata or trivia — only `chunk.content` (the actual text)
  - Do NOT change chunk boundaries or chunking logic

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 1, 3)
  - **Blocks**: Task 4

  **References**:

  **Pattern References**:
  - `packages/code-search/src/chunker/chunk-manager.ts:111-116` — Existing `computeFileHash()` using `createHash('sha256')`. Follow same pattern for `computeChunkHash()`.

  **Acceptance Criteria**:
  - [ ] `computeChunkHash(content)` function exists and returns SHA-256 hex string
  - [ ] Every chunk produced by `ChunkManager` has `chunkHash` set
  - [ ] Same content always produces same hash (deterministic)
  - [ ] `tsc --noEmit` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: computeChunkHash produces deterministic SHA-256
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Run: node -e "const { createHash } = require('crypto'); const h1 = createHash('sha256').update('function foo() {}').digest('hex'); const h2 = createHash('sha256').update('function foo() {}').digest('hex'); console.log(h1 === h2); console.log(h1.length);"
      2. Assert h1 === h2 (deterministic)
      3. Assert length is 64 (SHA-256 hex)
    Expected Result: true, 64
    Failure Indicators: false, or wrong length
    Evidence: .sisyphus/evidence/task-2-chunk-hash-compute.txt

  Scenario: Chunks produced by ChunkManager have chunkHash
    Tool: Bash (grep)
    Preconditions: pnpm build completed
    Steps:
      1. grep -n "chunkHash" packages/code-search/dist/chunker/chunk-manager.js
      2. Assert output contains "chunkHash"
    Expected Result: chunkHash assignment present in compiled output
    Failure Indicators: No match found
    Evidence: .sisyphus/evidence/task-2-chunk-hash-wired.txt
  ```

  **Commit**: YES (with Tasks 1, 4, 5)
  - Files: `chunk-manager.ts`

- [x] 3. Fix IgnoreManager negation patterns

  **What to do**:
  - In `packages/code-search/src/util/ignore-manager.ts`:
    - Fix `addGitignoreRules()` (lines 113-118) to properly handle `!` negation patterns
    - Current bug: lines starting with `!` are NOT stripped of `!` prefix — they get added as-is, but the `ignore` library treats `!foo` as a negation pattern ONLY if `add()` receives it correctly
    - Actually, the `ignore` npm package DOES support `!` natively via `add()`. The real bug is that `addGitignoreRules` at line 117 does `ig.add(patterns)` after filtering `#` comments and empty lines, but the `ignore` library's `add()` method expects patterns WITH the `!` prefix to handle negation. So the current code might actually work IF `ignore` handles `!` — need to verify.
    - If `ignore` handles `!` natively: the bug may be that `addPatterns()` (line 79) also receives `!` patterns but calls `ig.add()` which should handle them. Verify both code paths.
    - Write a quick test: `ignore().add(['*.log', '!important.log']).ignores('important.log')` → should return `false` (not ignored)
    - If negation is actually broken: fix the specific code path that strips or mishandles `!` prefix
  - Verify with actual `.gitignore` file containing `!important-file.js` pattern

  **Must NOT do**:
  - Do NOT replace the `ignore` npm package
  - Do NOT add `.codeignore` file support
  - Do NOT change the default patterns

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 1, 2)
  - **Blocks**: Task 6

  **References**:

  **Pattern References**:
  - `packages/code-search/src/util/ignore-manager.ts:113-118` — `addGitignoreRules()` method. This is where negation may be broken.
  - `packages/code-search/src/util/ignore-manager.ts:79-89` — `addPatterns()` method. Also needs to handle `!` correctly.

  **External References**:
  - `ignore` npm package docs: https://www.npmjs.com/package/ignore — negation patterns are supported via `!` prefix in `add()`.

  **Acceptance Criteria**:
  - [ ] `!important-file.js` in `.gitignore` correctly un-ignores the file (it is NOT ignored)
  - [ ] Adding negation pattern via `addPatterns(['!foo'])` works correctly
  - [ ] Existing non-negation patterns still work (regression check)
  - [ ] `tsc --noEmit` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Negation pattern un-ignores a previously ignored file
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Test the ignore library directly: node -e "const ig = require('ignore')(); ig.add(['*.log']); console.log('before negation:', ig.ignores('important.log')); ig.add(['!important.log']); console.log('after negation:', ig.ignores('important.log'));"
      2. Assert: before negation = true (ignored), after negation = false (not ignored)
    Expected Result: true, false
    Failure Indicators: Both return true (negation not working)
    Evidence: .sisyphus/evidence/task-3-negation-test.txt

  Scenario: IgnoreManager.addGitignoreRules handles negation
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Test IgnoreManager with negation: node -e "const { IgnoreManager } = require('./dist/util/ignore-manager.js'); const ig = new IgnoreManager('/tmp/test'); ig.addPatterns(['*.log']); console.log('ignored:', ig.isIgnored('/tmp/test/important.log')); ig.addGitignoreRules('!important.log\n'); console.log('after negation:', ig.isIgnored('/tmp/test/important.log'));"
    Expected Result: After negation, important.log is NOT ignored
    Failure Indicators: Still ignored after negation
    Evidence: .sisyphus/evidence/task-3-ignoremanager-negation.txt
  ```

  **Commit**: YES (with Task 6)
  - Message: `fix(code-search): IgnoreManager negation patterns + CLI consolidation`
  - Files: `ignore-manager.ts`

- [x] 4. Incremental indexing — skip re-embedding unchanged chunks

  **What to do**:
  - In `packages/code-search/src/engine.ts`:
    - Modify `indexPaths()` flow for changed files:
      1. Before embedding: get existing chunk hashes for this path from DB via `db.getChunksByPath(filePath, projectPath)` → `Map<chunkHash, chunkId>`
      2. For each new chunk: check if `chunk.chunkHash` exists in the stored hashes map
      3. If hash matches → chunk unchanged, skip embedding, remove from "to delete" set
      4. If hash NOT in map → new/changed chunk, needs embedding
      5. After processing: delete stale chunks (hashes in old map but NOT in new chunks) by chunk ID
      6. Only call `embedder.embedChunks()` for the changed/new chunks subset
      7. Only call `db.upsertChunks()` for the changed/new chunks subset
    - Add `db.removeChunksByIds(ids: string[])` method if not exists — for deleting stale chunks by ID
  - In `packages/code-search/src/db/database.ts`:
    - Implement `getChunksByPath(path, projectPath)` → `Promise<Map<string, string>>` (chunkHash → chunkId)
    - Implement `removeChunksByIds(ids: string[])` → `Promise<void>` — delete chunks by their IDs
    - Modify `upsertChunks()` to call `removeByPath()` FIRST before adding new chunks (prevent orphan accumulation)
  - Verify end-to-end: index a file, change 1 line, re-index → only changed chunks re-embedded

  **Must NOT do**:
  - Do NOT add content-similarity-based reuse — only exact hash match
  - Do NOT add background orphan cleanup job
  - Do NOT change initial bulk indexing flow
  - Do NOT add caching layer for hash computation

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO — depends on Tasks 1, 2
  - **Parallel Group**: Sequential (Wave 2)
  - **Blocks**: Task 5

  **References**:

  **Pattern References**:
  - `packages/code-search/src/engine.ts` — `indexPaths()` method. This is where the incremental logic goes.
  - `packages/code-search/src/db/database.ts:317-335` — `getIndexedFileHashes()` pattern for creating a similar `getChunksByPath()`.
  - `packages/code-search/src/db/database.ts:964` — `removeByPath()` method. Use as pattern for `removeChunksByIds()`.

  **API/Type References**:
  - `packages/code-search/src/db/database.ts` — Database class public API.

  **Acceptance Criteria**:
  - [ ] `getChunksByPath()` returns stored chunk hashes for a given file path
  - [ ] `removeChunksByIds()` can delete stale chunks by their IDs
  - [ ] `upsertChunks()` calls `removeByPath()` before adding (no orphan accumulation)
  - [ ] Editing 1 line in a file only re-embeds changed chunks (verified via log output or embed count)
  - [ ] Unchanged chunks retain their original embeddings (not re-embedded)
  - [ ] `tsc --noEmit` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Incremental indexing skips unchanged chunks
    Tool: Bash (node -e)
    Preconditions: pnpm build completed, a test JS file indexed
    Steps:
      1. Index a test file with multiple functions
      2. Modify 1 function in the file
      3. Re-index and count how many chunks are embedded
      4. Assert: fewer chunks embedded than total chunks in file
    Expected Result: Only chunks with changed content are re-embedded
    Failure Indicators: All chunks re-embedded despite only 1 changing
    Evidence: .sisyphus/evidence/task-4-incremental-indexing.txt

  Scenario: Stale chunks are removed on file change
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Index a file with function A and B
      2. Remove function B from the file
      3. Re-index
      4. Query DB for chunks belonging to that file
      5. Assert: only function A's chunk remains
    Expected Result: Stale chunks deleted, only current chunks remain
    Failure Indicators: Function B's chunk still in DB
    Evidence: .sisyphus/evidence/task-4-stale-cleanup.txt
  ```

  **Commit**: YES (with Tasks 1, 2, 5)
  - Files: `engine.ts`, `database.ts`

- [x] 5. Watch handler hash check + orphan cleanup

  **What to do**:
  - In `packages/code-search/src/engine.ts`:
    - Modify the watch `handleChange` handler (around lines 296-308):
      1. Before re-chunking: compute current file hash
      2. Compare against stored file hash (from `db.getIndexedFileHashes()`)
      3. If hash matches → skip entirely (file didn't actually change)
      4. If hash changed → proceed with chunking + incremental embed (using Task 4 logic)
    - Ensure `removeByPath()` is called for the changed file before re-inserting (prevents orphans)
  - Verify: saving an unchanged file (e.g., `:w` in vim with no edits) does NOT trigger re-indexing

  **Must NOT do**:
  - Do NOT add debouncing (already exists at 300ms)
  - Do NOT change the file watcher library or config
  - Do NOT add retry/backoff logic for network mounts

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO — depends on Tasks 1, 4
  - **Parallel Group**: Sequential (Wave 2)
  - **Blocks**: F1-F4

  **References**:

  **Pattern References**:
  - `packages/code-search/src/engine.ts:296-308` — Current watch handler. Add hash check at the top.
  - `packages/code-search/src/chunker/chunk-manager.ts:94-99` — File hash skip pattern. Same logic for watch handler.

  **Acceptance Criteria**:
  - [ ] Watch handler computes file hash before re-indexing
  - [ ] Unchanged file saves do NOT trigger re-chunking or re-embedding
  - [ ] Changed files trigger incremental re-embedding (only changed chunks)
  - [ ] `tsc --noEmit` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Watch handler skips unchanged files
    Tool: Code review
    Preconditions: pnpm build completed
    Steps:
      1. Read engine.ts handleChange handler
      2. Verify hash comparison exists before chunking
      3. Verify early return when hash matches
    Expected Result: Hash check prevents unnecessary re-indexing
    Failure Indicators: No hash check in watch handler
    Evidence: .sisyphus/evidence/task-5-watch-hash.txt

  Scenario: Watch handler calls removeByPath before re-insert
    Tool: Code review
    Preconditions: pnpm build completed
    Steps:
      1. Read engine.ts handleChange handler
      2. Verify removeByPath() is called before upsertChunks()
    Expected Result: No orphan chunk accumulation
    Failure Indicators: upsertChunks() without prior removeByPath()
    Evidence: .sisyphus/evidence/task-5-orphan-cleanup.txt
  ```

  **Commit**: YES (with Tasks 1, 2, 4)
  - Files: `engine.ts`

- [x] 6. Consolidate CLI code-index.js to use IgnoreManager

  **What to do**:
  - In `packages/cli/src/commands/code-index.js`:
    - Remove the duplicate `createIgnoreManager()` function (lines ~34-92)
    - Import `IgnoreManager` from `@opencode-telegram/code-search`
    - Replace `createIgnoreManager()` usage with `IgnoreManager.fromDirectory(projectPath)`
    - If `ignorePatterns` are passed: use `ignoreManager.addPatterns(patterns)` instead of building a separate ig instance
    - Remove all duplicated default patterns (they're already in `IgnoreManager.getDefaultPatterns()` — may need to export if not already)
  - In `packages/code-search/src/util/ignore-manager.ts`:
    - Ensure `IgnoreManager` is exported from the package's main index
    - If `getDefaultPatterns()` is private, either make it public or ensure `fromDirectory()` + `addPatterns()` covers the CLI use case
  - Verify CLI still works: `opencode-telegram code-index <path>`

  **Must NOT do**:
  - Do NOT change the CLI's command interface or arguments
  - Do NOT add new CLI options
  - Do NOT modify the IgnoreManager's default patterns (CLI should match current behavior)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO — depends on Task 3
  - **Parallel Group**: Wave 2 (with Tasks 4, 5)
  - **Blocks**: F1-F4

  **References**:

  **Pattern References**:
  - `packages/cli/src/commands/code-index.js:34-92` — Duplicate `createIgnoreManager()` function. This is what gets replaced.
  - `packages/code-search/src/util/ignore-manager.ts` — Source of truth for ignore logic.

  **Acceptance Criteria**:
  - [ ] `createIgnoreManager()` function removed from `code-index.js`
  - [ ] `code-index.js` imports and uses `IgnoreManager` from code-search package
  - [ ] CLI behavior unchanged (same files ignored)
  - [ ] `tsc --noEmit` passes (if CLI is TypeScript) or no runtime errors

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: CLI uses IgnoreManager instead of duplicate code
    Tool: Bash (grep)
    Preconditions: Changes applied
    Steps:
      1. grep -n "createIgnoreManager" packages/cli/src/commands/code-index.js
      2. Assert: no matches (function removed)
      3. grep -n "IgnoreManager" packages/cli/src/commands/code-index.js
      4. Assert: matches found (import present)
    Expected Result: createIgnoreManager removed, IgnoreManager imported
    Failure Indicators: createIgnoreManager still present, or IgnoreManager not imported
    Evidence: .sisyphus/evidence/task-6-cli-consolidation.txt

  Scenario: CLI still correctly ignores node_modules
    Tool: Bash (grep)
    Preconditions: Changes applied
    Steps:
      1. Verify IgnoreManager's default patterns include 'node_modules'
    Expected Result: node_modules still ignored by default
    Failure Indicators: Default patterns missing or changed
    Evidence: .sisyphus/evidence/task-6-cli-ignore-behavior.txt
  ```

  **Commit**: YES (with Task 3)
  - Message: `fix(code-search): IgnoreManager negation patterns + CLI consolidation`
  - Files: `ignore-manager.ts`, `code-index.js`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns. Check evidence files.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `tsc --noEmit` + `pnpm build`. Review all changed files for: `as any`, `@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports.
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Manual QA** — `unspecified-high`
  Start from clean state. Execute EVERY QA scenario from EVERY task. Test cross-task integration. Test edge cases: empty chunks, negated ignore patterns, rapid watch events. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Detect cross-task contamination.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | VERDICT`

---

## Commit Strategy

- **1+2+4+5**: `feat(code-search): add chunk content hashing for incremental indexing` - types.ts, chunk-manager.ts, stride.ts, database.ts, engine.ts
- **3+6**: `fix(code-search): IgnoreManager negation patterns + CLI consolidation` - ignore-manager.ts, code-index.js

---

## Success Criteria

### Verification Commands
```bash
cd packages/code-search && pnpm typecheck  # Expected: no errors
cd packages/code-search && pnpm build      # Expected: compiles successfully
```

### Final Checklist
- [ ] Unchanged chunks are NOT re-embedded on file change
- [ ] `!pattern` negation works in `.gitignore` files
- [ ] CLI uses `IgnoreManager` (no duplicate ignore code)
- [ ] Watch handler checks file hash before re-indexing
- [ ] No orphan chunks accumulate on file change
