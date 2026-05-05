# Add Jina Embeddings v2 Base Code + Dynamic Dimensions

## TL;DR

> **Quick Summary**: Add jina-embeddings-v2-base-code as a selectable model via the existing Jina cloud API, make embedding dimensions dynamic (768 for v2, 1024 for v3), and enable explicit provider+model selection in config.
> 
> **Deliverables**:
> - Model-to-dimensions map supporting all known models
> - Dynamic `JinaEmbedder.dimensions` based on selected model
> - Config-based provider+model selection (not just auto-chain)
> - Database dimension safety (detect mismatch, warn, require reindex)
> - SemanticIndex dimension check uses active provider dims (not global constant)
> 
> **Estimated Effort**: Short
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Task 5

---

## Context

### Original Request
Add jina-embeddings-v2-base-code like they do it in ck-embed — as a selectable embedding model with correct dimensions (768, not 1024).

### Interview Summary
**Key Discussions**:
- User wants cloud API (not local ONNX) — just a different model name on the existing Jina API
- User wants to CHOOSE between models: jina v2, jina v3, openai, voyage
- Dimensions must be dynamic (768 for v2, 1024 for v3, 1536 for voyage, 3072 for openai)
- No automated tests needed
- No MCP server or CLI changes

**Research Findings**:
- JinaEmbedder already supports `config.model` but dimensions are hardcoded to 1024
- `EMBEDDING_DIMENSIONS = 1024 as const` in types.ts is used in 5+ places including LanceDB schema
- LanceDB `FixedSizeList` schema is fixed at table creation — changing dimensions breaks existing tables
- SemanticIndex manifest check compares against global constant, not active provider

### Metis Review
**Identified Gaps** (addressed):
- **Database schema mismatch**: LanceDB uses `FixedSizeList(EMBEDDING_DIMENSIONS)` — if dimensions change, existing tables break. Resolution: Detect mismatch at DB init, drop+recreate table (existing behavior for corrupted tables).
- **SemanticIndex manifest check**: Compares against global constant. Resolution: Compare against active provider dimensions.
- **LocalEmbedder hardcoded to 1024**: Resolution: Make dynamic based on active provider.
- **Jina v2 API `task` parameter**: v2 may not support `task: 'Retrieval'`. Resolution: Make task parameter conditional based on model version.

---

## Work Objectives

### Core Objective
Make embedding dimensions dynamic per model and add jina-embeddings-v2-base-code as a selectable option.

### Concrete Deliverables
- `MODEL_DIMENSIONS` map in types.ts
- Updated `JinaEmbedder` with dynamic dimensions
- Updated `EmbedderConfig` with proper model selection
- Database dimension mismatch detection and auto-recovery
- SemanticIndex using dynamic dimensions

### Definition of Done
- [ ] `Embedder.getDimensions()` returns 768 when `model: 'jina-embeddings-v2-base-code'`
- [ ] `Embedder.getDimensions()` returns 1024 when `model: 'jina-embeddings-v3'` (backward compat)
- [ ] Switching models with existing DB triggers table recreation (not crash)
- [ ] SemanticIndex detects dimension mismatch and triggers rebuild

### Must Have
- jina-embeddings-v2-base-code returns 768-dim vectors
- Backward compatibility: default stays jina-embeddings-v3 (1024 dims)
- Database safety: dimension mismatch detected and handled gracefully

### Must NOT Have (Guardrails)
- Do NOT add local ONNX inference (cloud API only)
- Do NOT add automated tests (user declined)
- Do NOT modify MCP server or REST API endpoints
- Do NOT add new embedding providers
- Do NOT change the default model (keep jina-embeddings-v3)
- Do NOT implement per-project model selection (global config only)
- Do NOT add database migration tools
- Do NOT over-abstract — keep it simple, a map lookup is sufficient

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** - ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (vitest)
- **Automated tests**: NO (user declined)
- **Framework**: vitest (available but not used)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **API/Backend**: Use Bash (curl) — Send requests, assert status + response fields
- **Library/Module**: Use Bash (node REPL) — Import, call functions, compare output

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately - foundation):
├── Task 1: Add MODEL_DIMENSIONS map + remove hardcoded EMBEDDING_DIMENSIONS [quick]
├── Task 2: Make JinaEmbedder dimensions dynamic + fix task param for v2 [quick]
└── Task 3: Update EmbedderConfig + MultiProviderEmbedder for model selection [quick]

Wave 2 (After Wave 1 - integration):
├── Task 4: Database dimension safety (depends: 1) [quick]
├── Task 5: SemanticIndex + SemanticRetrieval dynamic dimensions (depends: 1, 2) [quick]
└── Task 6: LocalEmbedder + backward compat + final wiring (depends: 1, 2, 3) [quick]

Wave FINAL (After ALL tasks — 4 parallel reviews):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Real manual QA (unspecified-high)
└── F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay

Critical Path: Task 1 → Task 4 → Task 6 → F1-F4
Parallel Speedup: ~50% faster than sequential
Max Concurrent: 3 (Wave 1)
```

### Dependency Matrix

- **1**: - → 2, 3, 4, 5, 6
- **2**: 1 → 3, 5, 6
- **3**: 1, 2 → 6
- **4**: 1 → 6
- **5**: 1, 2 → 6
- **6**: 1, 2, 3, 4, 5 → F1-F4

### Agent Dispatch Summary

- **Wave 1**: **3** — T1 → `quick`, T2 → `quick`, T3 → `quick`
- **Wave 2**: **3** — T4 → `quick`, T5 → `quick`, T6 → `quick`
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. Add MODEL_DIMENSIONS map + remove hardcoded EMBEDDING_DIMENSIONS

  **What to do**:
  - In `packages/code-search/src/types.ts`:
    - Add `MODEL_DIMENSIONS` map: `{ 'jina-embeddings-v3': 1024, 'jina-embeddings-v2-base-code': 768, 'text-embedding-3-large': 3072, 'text-embedding-3-small': 1536, 'voyage-code-2': 1536, 'voyage-code-3': 1024 }`
    - Add `DEFAULT_EMBEDDING_MODEL = 'jina-embeddings-v3'` constant
    - Add `DEFAULT_EMBEDDING_DIMENSIONS = 1024` constant (derived from model map: `MODEL_DIMENSIONS[DEFAULT_EMBEDDING_MODEL]`)
    - Keep `EMBEDDING_DIMENSIONS` as an alias for `DEFAULT_EMBEDDING_DIMENSIONS` for backward compatibility (with a `@deprecated` JSDoc comment pointing to `getDimensionsForModel()`)
    - Add helper function `getDimensionsForModel(model: string): number` that looks up the map and throws for unknown models
    - Remove the `as const` from `EMBEDDING_DIMENSIONS` and change type from `1024` to `number`
    - Remove the `EmbeddingDimensions = 1024` type alias

  **Must NOT do**:
  - Do NOT remove `EMBEDDING_DIMENSIONS` entirely (too many consumers)
  - Do NOT change LanceDB schema here (that's Task 4)
  - Do NOT add Zod validation here (that's Task 3)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single file change, well-scoped, no ambiguity
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `fullstack-dev`: Not needed — single TypeScript file edit

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Tasks 2, 3, 4, 5, 6
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References** (existing code to follow):
  - `packages/code-search/src/types.ts:130` — Current `EMBEDDING_DIMENSIONS = 1024 as const` definition and `EmbeddingDimensions = 1024` type alias. This is the exact line to modify.

  **API/Type References** (contracts to implement against):
  - `packages/code-search/src/db/database.ts:94` — `FixedSizeList(EMBEDDING_DIMENSIONS, ...)` — consumer of EMBEDDING_DIMENSIONS, must continue to compile
  - `packages/code-search/src/embedder/jina-embedder.ts:41` — `readonly dimensions = 1024` — consumer that will be fixed in Task 2

  **WHY Each Reference Matters**:
  - `types.ts:130` is the source of truth being changed
  - `database.ts:94` uses EMBEDDING_DIMENSIONS in LanceDB schema — must still compile after this change
  - `jina-embedder.ts:41` hardcodes 1024 — will be fixed in Task 2 but must still compile after Task 1

  **Acceptance Criteria**:

  - [ ] `MODEL_DIMENSIONS` map exists in types.ts with all 6 model entries
  - [ ] `getDimensionsForModel('jina-embeddings-v2-base-code')` returns 768
  - [ ] `getDimensionsForModel('jina-embeddings-v3')` returns 1024
  - [ ] `EMBEDDING_DIMENSIONS` still exists as alias (backward compat)
  - [ ] `tsc --noEmit` passes with no errors

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Model dimensions map returns correct values
    Tool: Bash (node -e)
    Preconditions: code-search package built (pnpm build)
    Steps:
      1. Run: node -e "const { MODEL_DIMENSIONS, getDimensionsForModel } = require('./packages/code-search/dist/types.js'); console.log(MODEL_DIMENSIONS['jina-embeddings-v2-base-code'])"
      2. Assert output contains "768"
      3. Run: node -e "const { MODEL_DIMENSIONS } = require('./packages/code-search/dist/types.js'); console.log(MODEL_DIMENSIONS['jina-embeddings-v3'])"
      4. Assert output contains "1024"
    Expected Result: Correct dimension values printed for each model
    Failure Indicators: "undefined" printed, or module import error
    Evidence: .sisyphus/evidence/task-1-model-dims.txt

  Scenario: Unknown model throws error
    Tool: Bash (node -e)
    Preconditions: code-search package built
    Steps:
      1. Run: node -e "const { getDimensionsForModel } = require('./packages/code-search/dist/types.js'); try { getDimensionsForModel('nonexistent-model'); console.log('NO_ERROR'); } catch(e) { console.log('ERROR_CAUGHT'); }"
      2. Assert output contains "ERROR_CAUGHT"
    Expected Result: Error thrown for unknown model
    Failure Indicators: "NO_ERROR" printed
    Evidence: .sisyphus/evidence/task-1-unknown-model.txt
  ```

  **Commit**: YES (solo)
  - Message: `feat(embedder): add MODEL_DIMENSIONS map and deprecate hardcoded EMBEDDING_DIMENSIONS`
  - Files: `packages/code-search/src/types.ts`
  - Pre-commit: `cd packages/code-search && pnpm typecheck`

- [x] 2. Make JinaEmbedder dimensions dynamic + fix task param for v2

  **What to do**:
  - In `packages/code-search/src/embedder/jina-embedder.ts`:
    - Change `JinaEmbedder` class:
      - Replace `readonly dimensions = 1024` with `private _dimensions: number;` and `get dimensions(): number { return this._dimensions; }`
      - In constructor: look up dimensions from `MODEL_DIMENSIONS` map via `getDimensionsForModel(config.model ?? 'jina-embeddings-v3')`
      - If model is unknown, fall back to 1024 (backward compat) and log warning
    - Fix the `task` parameter in `embedBatch()`:
      - Jina v3 supports `task: 'Retrieval'`, but Jina v2 does NOT support the `task` parameter
      - Make the `task` field conditional: only include it for v3+ models (check if model string includes 'v3')
      - For v2 models, omit the `task` field entirely from the request body
    - Update `VoyageEmbedder` and `OpenAIEmbedder` similarly: make `dimensions` dynamic from map based on model name
    - Update `LocalEmbedder`: accept dimensions as constructor parameter (already does, just needs correct value)

  **Must NOT do**:
  - Do NOT change `MultiProviderEmbedder` chain logic (Task 3)
  - Do NOT change `Embedder` class (Task 3)
  - Do NOT add new providers

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Well-scoped changes to one file, clear pattern to follow
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Tasks 3, 5, 6
  - **Blocked By**: Task 1 (needs MODEL_DIMENSIONS map)

  **References**:

  **Pattern References**:
  - `packages/code-search/src/embedder/jina-embedder.ts:39-64` — Current `JinaEmbedder` class with hardcoded `dimensions = 1024` and `model = 'jina-embeddings-v3'`. This is the exact class to modify.
  - `packages/code-search/src/embedder/jina-embedder.ts:93-104` — `embedBatch()` method sending `task: 'Retrieval'`. This must be conditional for v2 models.

  **API/Type References**:
  - `packages/code-search/src/types.ts` — `MODEL_DIMENSIONS` map and `getDimensionsForModel()` (added in Task 1)
  - Jina v2 API docs: v2 does NOT accept `task` parameter, v3 does

  **WHY Each Reference Matters**:
  - `jina-embedder.ts:39-64` is the class being modified — dimensions must become dynamic
  - `jina-embedder.ts:93-104` sends `task: 'Retrieval'` which is v3-only — must be conditional
  - `types.ts` provides the dimension lookup function needed for dynamic dims

  **Acceptance Criteria**:

  - [ ] `new JinaEmbedder({ model: 'jina-embeddings-v2-base-code' }).dimensions` returns 768
  - [ ] `new JinaEmbedder({ model: 'jina-embeddings-v3' }).dimensions` returns 1024
  - [ ] `new JinaEmbedder().dimensions` returns 1024 (default, backward compat)
  - [ ] Jina v2 embedBatch request body does NOT include `task` field
  - [ ] Jina v3 embedBatch request body DOES include `task: 'Retrieval'`
  - [ ] `tsc --noEmit` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: JinaEmbedder dimensions are dynamic per model
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Run: node -e "const { JinaEmbedder } = require('./packages/code-search/dist/embedder/jina-embedder.js'); const e1 = new JinaEmbedder({ model: 'jina-embeddings-v2-base-code' }); console.log('v2-dims:', e1.dimensions); const e2 = new JinaEmbedder({ model: 'jina-embeddings-v3' }); console.log('v3-dims:', e2.dimensions); const e3 = new JinaEmbedder(); console.log('default-dims:', e3.dimensions);"
      2. Assert output contains "v2-dims: 768"
      3. Assert output contains "v3-dims: 1024"
      4. Assert output contains "default-dims: 1024"
    Expected Result: Correct dimensions for each model configuration
    Failure Indicators: Wrong dimension values, or module import error
    Evidence: .sisyphus/evidence/task-2-dynamic-dims.txt

  Scenario: Unknown model falls back gracefully
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Run: node -e "const { JinaEmbedder } = require('./packages/code-search/dist/embedder/jina-embedder.js'); const e = new JinaEmbedder({ model: 'unknown-model' }); console.log('dims:', e.dimensions);"
      2. Assert output contains "dims: 1024" (fallback)
    Expected Result: Fallback to 1024 for unknown model
    Failure Indicators: Error thrown, or wrong dimension value
    Evidence: .sisyphus/evidence/task-2-unknown-fallback.txt
  ```

  **Commit**: YES (solo)
  - Message: `feat(embedder): make JinaEmbedder dimensions dynamic per model`
  - Files: `packages/code-search/src/embedder/jina-embedder.ts`
  - Pre-commit: `cd packages/code-search && pnpm typecheck`

- [x] 3. Update EmbedderConfig + MultiProviderEmbedder for model selection

  **What to do**:
  - In `packages/code-search/src/types.ts`:
    - Update `EmbedderConfig` interface: change `provider: 'jina' | 'voyage' | 'openai' | 'local'` to also accept `'jina-v2'` as a convenience alias that sets `model: 'jina-embeddings-v2-base-code'`
  - In `packages/code-search/src/embedder/jina-embedder.ts`:
    - Update `EmbeddingProvider` interface: `name` type should include `'jina-v2'`
    - Update `MultiProviderEmbedder`:
      - Accept `model` from config and pass it to `JinaEmbedder`
      - When config specifies `provider: 'jina-v2'`, create `JinaEmbedder` with `model: 'jina-embeddings-v2-base-code'`
      - When config specifies `provider: 'jina'` with explicit `model`, pass that model through
      - When config specifies `provider: 'jina'` without model, default to `jina-embeddings-v3`
      - Make `get dimensions()` dynamic: return `this.activeProvider?.dimensions ?? 1024`
      - Make `LocalEmbedder` dimensions match the first provider in the chain (not hardcoded 1024)
    - Update `ProviderChain.addProvider` to log the model name alongside provider name
  - In `packages/code-search/src/embedder/embedder.ts`:
    - Update `Embedder` class:
      - `getDimensions()` should return `this.multiProvider.dimensions` (dynamic), not `EMBEDDING_DIMENSIONS`
      - Pass `model` from config through to `MultiProviderEmbedder`
    - Remove import of `EMBEDDING_DIMENSIONS` from embedder.ts (use dynamic dimensions instead)

  **Must NOT do**:
  - Do NOT remove the auto-chain fallback behavior (keep Jina → Voyage → OpenAI → Local)
  - Do NOT add REST API endpoints for model switching
  - Do NOT add Zod schema validation (keep it simple — just type-level)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Config wiring changes, well-defined scope
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2) — but note: depends on Task 1 and 2 conceptually; if Tasks 1+2 aren't done, can prepare the structure and integrate later
  - **Blocks**: Task 6
  - **Blocked By**: Task 1 (needs MODEL_DIMENSIONS), Task 2 (needs dynamic JinaEmbedder)

  **References**:

  **Pattern References**:
  - `packages/code-search/src/embedder/jina-embedder.ts:460-523` — Current `MultiProviderEmbedder` class. This is where model selection must be wired in. Note how it creates `new JinaEmbedder(config)` at line 514 — this is where `config.model` must flow through.
  - `packages/code-search/src/embedder/embedder.ts:22-78` — Current `Embedder` class wrapper. `getDimensions()` at line 76 returns `EMBEDDING_DIMENSIONS` — must return dynamic value instead.

  **API/Type References**:
  - `packages/code-search/src/types.ts:89-98` — Current `EmbedderConfig` interface with `provider: 'jina' | 'voyage' | 'openai' | 'local'`

  **WHY Each Reference Matters**:
  - `MultiProviderEmbedder` is the central wiring point — where config meets providers
  - `Embedder` is the public API surface — `getDimensions()` must be dynamic
  - `EmbedderConfig` is the config schema — must accept model selection

  **Acceptance Criteria**:

  - [ ] `new Embedder({ provider: 'jina', model: 'jina-embeddings-v2-base-code' }).getDimensions()` returns 768
  - [ ] `new Embedder({ provider: 'jina' }).getDimensions()` returns 1024 (backward compat)
  - [ ] `new Embedder({ provider: 'jina-v2' }).getDimensions()` returns 768 (convenience alias)
  - [ ] `MultiProviderEmbedder` logs model name on initialization
  - [ ] `tsc --noEmit` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Config-based model selection works end-to-end
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Run: node -e "const { Embedder } = require('./packages/code-search/dist/embedder/embedder.js'); const e = new Embedder({ provider: 'jina', model: 'jina-embeddings-v2-base-code' }); console.log('dims:', e.getDimensions());"
      2. Assert output contains "dims: 768"
    Expected Result: Embedder respects model config and returns 768
    Failure Indicators: Wrong dimensions, import error
    Evidence: .sisyphus/evidence/task-3-config-selection.txt

  Scenario: Backward compatibility without model field
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Run: node -e "const { Embedder } = require('./packages/code-search/dist/embedder/embedder.js'); const e = new Embedder({ provider: 'jina' }); console.log('dims:', e.getDimensions());"
      2. Assert output contains "dims: 1024"
    Expected Result: Default config still returns 1024 (backward compat)
    Failure Indicators: Different dimension value, import error
    Evidence: .sisyphus/evidence/task-3-backward-compat.txt
  ```

  **Commit**: YES (groups with Task 6)
  - Message: `feat(embedder): add config-based provider+model selection`
  - Files: `packages/code-search/src/types.ts`, `packages/code-search/src/embedder/jina-embedder.ts`, `packages/code-search/src/embedder/embedder.ts`
  - Pre-commit: `cd packages/code-search && pnpm typecheck`

- [x] 4. Database dimension safety — detect mismatch and auto-recover

  **What to do**:
  - In `packages/code-search/src/db/database.ts`:
    - The `Database` constructor should accept an `embeddingDimensions` parameter (default: `DEFAULT_EMBEDDING_DIMENSIONS`)
    - In `initDatabase()`, when opening an existing table:
      - Read the schema of the existing table
      - Check if the `vector` field's `FixedSizeList` length matches the requested `embeddingDimensions`
      - If mismatch: log warning `[Database] Dimension mismatch: existing table has X dims, requested Y dims. Dropping and recreating table.`, then drop and recreate the table (existing pattern for corrupted tables)
    - In `upsertChunks()`, replace `EMBEDDING_DIMENSIONS` with `this.embeddingDimensions` in:
      - The `FixedSizeList` schema definition (line 208)
      - The fallback `new Array(EMBEDDING_DIMENSIONS).fill(0)` (line 226)
    - Import `DEFAULT_EMBEDDING_DIMENSIONS` instead of `EMBEDDING_DIMENSIONS`

  **Must NOT do**:
  - Do NOT add migration tools (just drop+recreate, which is the existing pattern for corrupted tables)
  - Do NOT change other table schemas (dependency_graph, graph_nodes, graph_edges — they don't use vectors)
  - Do NOT add per-project dimension tracking in the DB

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single file change, well-understood pattern (existing corrupted-table recovery)
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (partial)
  - **Parallel Group**: Wave 2 (with Tasks 5, 6)
  - **Blocks**: Task 6
  - **Blocked By**: Task 1 (needs MODEL_DIMENSIONS map)

  **References**:

  **Pattern References**:
  - `packages/code-search/src/db/database.ts:134-144` — Existing pattern for table recreation on corruption: catch error, `db.dropTable()`, `db.createEmptyTable()`. Follow this exact pattern for dimension mismatch.
  - `packages/code-search/src/db/database.ts:81-97` — LanceDB schema definition with `FixedSizeList(EMBEDDING_DIMENSIONS, ...)`. Replace `EMBEDDING_DIMENSIONS` with `this.embeddingDimensions`.

  **API/Type References**:
  - `packages/code-search/src/types.ts` — `DEFAULT_EMBEDDING_DIMENSIONS`, `EMBEDDING_DIMENSIONS` (from Task 1)

  **WHY Each Reference Matters**:
  - `database.ts:134-144` is the existing table-recovery pattern to follow
  - `database.ts:81-97` is the schema definition that must become dynamic
  - Without this change, switching from 1024 to 768 dims would crash on upsert

  **Acceptance Criteria**:

  - [ ] `Database` constructor accepts `embeddingDimensions` parameter
  - [ ] Existing table with mismatched dimensions is detected and recreated
  - [ ] `upsertChunks` uses `this.embeddingDimensions` instead of `EMBEDDING_DIMENSIONS`
  - [ ] `tsc --noEmit` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Database accepts dynamic dimensions
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Run: node -e "const { Database } = require('./packages/code-search/dist/db/database.js'); const db = new Database({ uri: '/tmp/test-lance-db-dims', embeddingDimensions: 768 }); console.log('created with 768 dims');"
      2. Assert no error thrown
    Expected Result: Database created successfully with 768 dimensions
    Failure Indicators: Error thrown, or "EMBEDDING_DIMENSIONS" reference error
    Evidence: .sisyphus/evidence/task-4-db-dims.txt

  Scenario: Dimension mismatch triggers table recreation
    Tool: Bash (node -e)
    Preconditions: pnpm build completed, test DB exists with 1024-dim table
    Steps:
      1. Create DB with 1024 dims, insert a test vector
      2. Open same DB with 768 dims
      3. Assert warning logged about dimension mismatch
      4. Assert table recreated (no crash)
    Expected Result: Table dropped and recreated with new dimensions, no crash
    Failure Indicators: Crash, error thrown, or silent dimension mismatch
    Evidence: .sisyphus/evidence/task-4-dim-mismatch.txt
  ```

  **Commit**: YES (solo)
  - Message: `fix(db): add dimension mismatch detection and auto-recovery`
  - Files: `packages/code-search/src/db/database.ts`
  - Pre-commit: `cd packages/code-search && pnpm typecheck`

- [x] 5. SemanticIndex + SemanticRetrieval dynamic dimensions

  **What to do**:
  - In `packages/code-search/src/embedder/semantic-retrieval.ts`:
    - `SemanticIndex.load()` (line 73): Change `this.manifest.embeddingDimension !== EMBEDDING_DIMENSIONS` to `this.manifest.embeddingDimension !== this.embedder.dimensions` — compare against active provider's dimensions, not global constant
    - `SemanticIndex.build()` (line 146-147): Change `embeddingModel: 'jina-embeddings-v3'` to `embeddingModel: this.embedder.providerName === 'jina' ? (config from embedder) : 'unknown'` — or simply use `this.embedder` model info. Change `embeddingDimension: EMBEDDING_DIMENSIONS` to `embeddingDimension: this.embedder.dimensions`
    - `SemanticIndex.build()` (line 118-125): Fix the batch embedding logic — currently it embeds each batch as a single joined string (`batch.join(' ')`), which loses individual chunk embeddings. This should call `embedBatch` properly with the array of texts.
    - Remove import of `EMBEDDING_DIMENSIONS` from `semantic-retrieval.ts`, import `DEFAULT_EMBEDDING_DIMENSIONS` if needed for fallback
    - `SemanticRetrieval` constructor: pass model info through to `MultiProviderEmbedder`

  **Must NOT do**:
  - Do NOT change the `SemanticManifest` interface
  - Do NOT change the `.bfs` binary format for vectors
  - Do NOT add per-project model tracking

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single file, clear substitutions, one logic fix
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 4, 6)
  - **Blocks**: Task 6
  - **Blocked By**: Task 1 (needs MODEL_DIMENSIONS), Task 2 (needs dynamic JinaEmbedder.dimensions)

  **References**:

  **Pattern References**:
  - `packages/code-search/src/embedder/semantic-retrieval.ts:73` — `this.manifest.embeddingDimension !== EMBEDDING_DIMENSIONS` — the exact check to change to use `this.embedder.dimensions`
  - `packages/code-search/src/embedder/semantic-retrieval.ts:118-125` — Batch embedding logic that joins texts into one string instead of embedding individually. This is a bug — should call `embedder.embedBatch(batch)` not `embedQuery(batch.join(' '))`.

  **API/Type References**:
  - `packages/code-search/src/types.ts` — `DEFAULT_EMBEDDING_DIMENSIONS` (from Task 1)

  **WHY Each Reference Matters**:
  - `semantic-retrieval.ts:73` uses hardcoded EMBEDDING_DIMENSIONS for manifest check — must be dynamic
  - `semantic-retrieval.ts:118-125` has a bug where batches are joined into one string instead of embedded individually — this should be fixed

  **Acceptance Criteria**:

  - [ ] `SemanticIndex.load()` compares manifest dimension against `this.embedder.dimensions`
  - [ ] `SemanticIndex.build()` writes `this.embedder.dimensions` to manifest
  - [ ] `SemanticIndex.build()` uses `embedBatch` properly (not joining texts)
  - [ ] No references to `EMBEDDING_DIMENSIONS` constant remain in semantic-retrieval.ts
  - [ ] `tsc --noEmit` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: SemanticIndex detects dimension mismatch
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Create a SemanticIndex with embedder that has 768 dims
      2. Create a manifest.json with embeddingDimension: 1024
      3. Call index.load(projectPath)
      4. Assert load() returns false (triggers rebuild)
    Expected Result: load() returns false when manifest dims don't match active provider dims
    Failure Indicators: load() returns true despite mismatch, or error thrown
    Evidence: .sisyphus/evidence/task-5-semantic-dims.txt

  Scenario: SemanticIndex build writes correct dimensions
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Create a SemanticIndex with embedder that has 768 dims
      2. Call index.build(chunks, projectPath)
      3. Read the generated manifest.json
      4. Assert manifest.embeddingDimension === 768
    Expected Result: Manifest records 768 (matching active provider)
    Failure Indicators: Manifest records 1024, or build fails
    Evidence: .sisyphus/evidence/task-5-semantic-build.txt
  ```

  **Commit**: YES (solo)
  - Message: `fix(semantic): use dynamic dimensions in SemanticIndex and fix batch embedding`
  - Files: `packages/code-search/src/embedder/semantic-retrieval.ts`
  - Pre-commit: `cd packages/code-search && pnpm typecheck`

- [x] 6. LocalEmbedder dynamic dims + backward compat + final wiring

  **What to do**:
  - In `packages/code-search/src/embedder/jina-embedder.ts`:
    - Update `LocalEmbedder` in `MultiProviderEmbedder`: pass active provider dimensions instead of hardcoded 1024
      - Change `this.local = new LocalEmbedder(1024)` to get dimensions from the first provider in the chain
      - If no API provider is available, default to `DEFAULT_EMBEDDING_DIMENSIONS`
    - Ensure `ProviderChain` and `MultiProviderEmbedder` log model name on initialization
  - In `packages/code-search/src/embedder/embedder.ts`:
    - Ensure `Embedder.getDimensions()` returns `this.multiProvider.dimensions` (dynamic)
    - Ensure `Embedder.getProviderName()` includes model info
  - Verify `engine.ts` passes `embeddingDimensions` to `Database` constructor:
    - Read `packages/code-search/src/engine.ts` to check how Database is created
    - If it creates Database with hardcoded dimensions, wire through the embedder's dimensions
  - Run full typecheck and build to verify everything compiles

  **Must NOT do**:
  - Do NOT add new providers
  - Do NOT change default model (keep jina-embeddings-v3)
  - Do NOT add CLI arguments or REST API endpoints

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Final wiring and verification, no new features
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO — depends on all prior tasks
  - **Parallel Group**: Wave 2 (last task)
  - **Blocks**: F1-F4
  - **Blocked By**: Tasks 1, 2, 3, 4, 5

  **References**:

  **Pattern References**:
  - `packages/code-search/src/embedder/jina-embedder.ts:517` — `new LocalEmbedder(1024)` hardcoded dimensions. Change to use active provider dims.
  - `packages/code-search/src/engine.ts` — Check how `Database` is constructed to ensure dynamic dimensions flow through

  **WHY Each Reference Matters**:
  - `jina-embedder.ts:517` is the last hardcoded dimension reference in the embedder layer
  - `engine.ts` is the top-level orchestrator — must pass dimensions to Database

  **Acceptance Criteria**:

  - [ ] `LocalEmbedder` uses dynamic dimensions matching active provider
  - [ ] `Embedder.getDimensions()` returns correct value for all model configurations
  - [ ] `pnpm typecheck` passes with zero errors
  - [ ] `pnpm build` succeeds
  - [ ] No remaining hardcoded `1024` dimension references in embedder code (except DEFAULT_EMBEDDING_DIMENSIONS constant)

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Full build succeeds after all changes
    Tool: Bash
    Preconditions: All prior tasks completed
    Steps:
      1. Run: cd packages/code-search && pnpm typecheck
      2. Assert exit code 0
      3. Run: cd packages/code-search && pnpm build
      4. Assert exit code 0
    Expected Result: Clean typecheck and build with no errors
    Failure Indicators: TypeScript errors, build failures
    Evidence: .sisyphus/evidence/task-6-full-build.txt

  Scenario: End-to-end dimension flow
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Run: node -e "const { Embedder } = require('./packages/code-search/dist/embedder/embedder.js'); const e = new Embedder({ provider: 'jina', model: 'jina-embeddings-v2-base-code' }); console.log('dims:', e.getDimensions());"
      2. Assert output contains "dims: 768"
      3. Run: node -e "const { Embedder } = require('./packages/code-search/dist/embedder/embedder.js'); const e = new Embedder({ provider: 'jina' }); console.log('dims:', e.getDimensions());"
      4. Assert output contains "dims: 1024"
    Expected Result: Full end-to-end flow returns correct dimensions for both v2 and v3
    Failure Indicators: Wrong dimensions, import errors
    Evidence: .sisyphus/evidence/task-6-e2e-dims.txt
  ```

  **Commit**: YES (with Task 3)
  - Message: `feat(embedder): finalize dynamic dimensions and backward compatibility`
  - Files: `packages/code-search/src/embedder/jina-embedder.ts`, `packages/code-search/src/embedder/embedder.ts`, `packages/code-search/src/engine.ts` (if needed)
  - Pre-commit: `cd packages/code-search && pnpm typecheck && pnpm build`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `tsc --noEmit` + linter. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration. Test edge cases: empty model string, unknown model, dimension mismatch. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **1**: `feat(embedder): add MODEL_DIMENSIONS map and remove hardcoded EMBEDDING_DIMENSIONS` - types.ts
- **2**: `feat(embedder): make JinaEmbedder dimensions dynamic per model` - jina-embedder.ts
- **3**: `feat(embedder): add config-based provider+model selection` - embedder.ts, jina-embedder.ts
- **4**: `fix(db): add dimension mismatch detection and auto-recovery` - database.ts
- **5**: `fix(semantic): use dynamic dimensions in SemanticIndex` - semantic-retrieval.ts
- **6**: `feat(embedder): wire dynamic LocalEmbedder and finalize backward compat` - jina-embedder.ts, embedder.ts

---

## Success Criteria

### Verification Commands
```bash
cd packages/code-search && pnpm typecheck  # Expected: no errors
cd packages/code-search && pnpm build      # Expected: compiles successfully
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] JinaEmbedder with v2 model returns 768 dims
- [ ] JinaEmbedder with v3 model returns 1024 dims (backward compat)
- [ ] Database handles dimension mismatch gracefully
- [ ] SemanticIndex uses dynamic dimensions
