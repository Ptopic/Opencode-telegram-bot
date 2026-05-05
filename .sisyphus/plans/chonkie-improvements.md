# Chonkie Chunking Improvements Plan

## TL;DR

> **Quick Summary**: Wire config values to Chonkie, add token-based striding with overlap, tag chunks with real types (function/class/module), add line-based fallback for WASM failures.
>
> **Deliverables**:
> - `maxChunkSize` from config actually passed to Chonkie chunkers
> - Token-based striding: large chunks split into overlapping windows
> - Chunks tagged as `'function'`/`'class'`/`'module'` instead of always `'block'`
> - Graceful line-based fallback when WASM/tree-sitter fails
> - Scope reduced to JS/TS/HTML/CSS only
>
> **Estimated Effort**: Short-Medium (1-2 days)
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Task 5

---

## Context

### Original Request
Extend Chonkie chunker with working config, token-based striding, proper chunk type tagging, and graceful fallback. Scope limited to JS/TS/HTML/CSS projects only.

### Interview Decisions
- **Striding**: Token-based (chars_per_token = 4.0, same as ck-chunk)
- **WASM failure**: Line-based fallback chunking (graceful degradation)
- **Languages**: JS/TS/HTML/CSS only — no Python, Go, Rust, Java, C/C++ support needed

### Research Findings
- `ChonkieExtractor` hardcodes `chunkSize: 2048` in `CodeChunker.create()` — config value never used
- `ChonkieExtractor` hardcodes `chunkType: 'block'` for all chunks — no type extraction
- `TreeSitterExtractor` also hardcodes `chunkSize: 2048` and `chunkType: 'block'`
- Chonkie's `Chunk` object has no native `chunkType` field — type must be inferred from content
- Chonkie `CodeChunker` returns chunks with `tokenCount` per chunk (already used in metadata)
- When Chonkie's WASM fails, no fallback exists — entire indexing crashes
- Both extractors maintain separate `CodeChunker` instances — could share chunkers

---

## Work Objectives

### Core Objective
Fix dead config wiring, add working striding, tag chunks correctly, add graceful fallback.

### Concrete Deliverables
- `ChunkManager` config values (`maxChunkSize`, `overlap`) flow to Chonkie chunker creation
- Token-based striding: chunks exceeding target size split into overlapping windows (overlap = 20% of chunk size)
- Chunks tagged as `'function'`/`'class'`/`'module'` by analyzing content with regex heuristics
- Line-based fallback chunking when AST/WASM fails
- HTML/CSS treated as `'module'` type with no special parsing

### Definition of Done
- [ ] `chunkSize: 512` config results in ~512-token chunks (tested)
- [ ] Chunks overlap by ~20% of chunk size when striding triggers
- [ ] `chunkType` is `'function'`/`'class'`/`'module'` based on content analysis, not hardcoded `'block'`
- [ ] Indexing a `.js` file with invalid WASM falls back to line-based chunking (not crash)
- [ ] `tsc --noEmit` passes with zero errors

### Must Have
- Config-driven chunk size (not hardcoded 2048)
- Working token-based striding with configurable overlap
- Chunks tagged correctly by type
- Graceful fallback on WASM failure

### Must NOT Have (Guardrails)
- Do NOT add Python, Go, Rust, Java, C, C++ language support
- Do NOT change the database schema
- Do NOT modify the embedding/embedder code
- Do NOT add automated tests
- Do NOT add MCP server changes

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
├── Task 1: Share CodeChunker instances + wire maxChunkSize config [quick]
├── Task 2: Add line-based fallback chunker [quick]
└── Task 3: Add token-based striding [quick]

Wave 2 (Integration):
├── Task 4: Tag chunks with real chunkType (function/class/module) [quick]
└── Task 5: Remove unused languages + final wiring [quick]

Wave FINAL:
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay
```

### Dependency Matrix

- **1**: - → 2, 3, 4, 5
- **2**: 1 → 4, 5
- **3**: 1 → 4, 5
- **4**: 2, 3 → 5
- **5**: 4 → F1-F4

---

## TODOs

- [x] 1. Share CodeChunker instances + wire maxChunkSize config

  **What to do**:
  - In `packages/code-search/src/chunker/chonkie-chunker.ts`:
    - `ChonkieExtractor` constructor accepts `chunkSize: number` parameter (default: 512)
    - Store `chunkSize` and pass it to each `CodeChunker.create({ chunkSize: this.chunkSize })` instead of hardcoded 2048
    - Remove `initialized`/`initError` state — throw error on failure (fallback handled in `ChunkManager`)
  - In `packages/code-search/src/graph/tree-sitter-extractor.ts`:
    - `TreeSitterExtractor` constructor accepts `chunkSize: number` parameter
    - Same pattern: pass to `CodeChunker.create()`
    - Remove duplicate WASM error handling — let it propagate (ChunkManager handles fallback)
  - In `packages/code-search/src/chunker/chunk-manager.ts`:
    - `ChunkManager` already has `maxChunkSize` in config — pass it to both extractors
    - `chunkWithChonkie()` passes `maxChunkSize` to `ChonkieExtractor.chunkFile()` or constructor
  - Verify Chonkie's `CodeChunker` actually accepts a `chunkSize` parameter (check `@chonkiejs/core` API)
    - If Chonkie doesn't support dynamic chunkSize, we must stride manually AFTER chunking

  **Must NOT do**:
  - Do NOT change the return type of `chunkFile()`
  - Do NOT add new public methods

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 2, 3)
  - **Blocks**: Tasks 4, 5

  **References**:

  **Pattern References** (existing code to follow):
  - `packages/code-search/src/chunker/chonkie-chunker.ts:29-34` — Current hardcoded `chunkSize: 2048`. Change to use `this.chunkSize`.
  - `packages/code-search/src/graph/tree-sitter-extractor.ts:47-50` — Same hardcoded pattern for TreeSitterExtractor.

  **API/Type References** (contracts to implement against):
  - `packages/code-search/src/chunker/chunk-manager.ts:8-12` — `ChunkManagerConfig` interface with `maxChunkSize: number`.

  **Acceptance Criteria**:

  - [x] `ChonkieExtractor` constructor accepts `chunkSize` param
  - [x] `ChonkieExtractor` passes `chunkSize` to `CodeChunker.create()`
  - [x] `TreeSitterExtractor` constructor accepts `chunkSize` param
  - [x] `ChunkManager` passes `maxChunkSize` to both extractors
  - [x] `tsc --noEmit` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Config-driven chunk size is passed to Chonkie
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Run: node -e "const { ChonkieExtractor } = require('./packages/code-search/dist/chunker/chonkie-chunker.js'); const e = new ChonkieExtractor(512); console.log('created with 512');"
      2. Assert no error thrown
    Expected Result: ChonkieExtractor accepts chunkSize param without error
    Failure Indicators: Constructor error, missing parameter
    Evidence: .sisyphus/evidence/task-1-chunk-size.txt
  ```

  **Commit**: YES (with Task 5)
  - Message: `fix(chunker): wire maxChunkSize config to Chonkie and share chunker instances`
  - Files: `packages/code-search/src/chunker/chonkie-chunker.ts`, `packages/code-search/src/graph/tree-sitter-extractor.ts`, `packages/code-search/src/chunker/chunk-manager.ts`

- [x] 2. Add line-based fallback chunker

  **What to do**:
  - In `packages/code-search/src/chunker/`:
    - Create `packages/code-search/src/chunker/line-chunker.ts`
    - `LineChunker` class with `chunkFile(content: string, filePath: string, chunkSize: number): CodeChunk[]`
    - Algorithm:
      1. Split content into non-empty lines
      2. Group lines into chunks targeting `chunkSize` tokens (estimate: chars / 4.0)
      3. Each chunk gets `chunkType: 'module'` as a sensible default for plain text
      4. Lines are joined with `'\n'`
    - If total content < chunkSize, return single chunk
  - In `packages/code-search/src/chunker/chunk-manager.ts`:
    - `chunkWithChonkie()` wraps `chonkieExtractor.chunkFile()` in try/catch
    - On error: log warning, fall back to `lineChunker.chunkFile()`
    - Track fallback in stats/metrics if possible

  **Must NOT do**:
  - Do NOT throw if line chunker also fails — return empty array (file unindexable)
  - Do NOT change the public API of `chunkFile()`

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 1, 3)
  - **Blocks**: Task 5

  **References**:

  **Pattern References** (existing code to follow):
  - `packages/code-search/src/chunker/chonkie-chunker.ts:71-89` — Current chunk mapping. Follow same `CodeChunk` structure.

  **WHY Each Reference Matters**:
  - `chonkie-chunker.ts:71-89` shows the exact `CodeChunk` shape returned. LineChunker must match it.

  **Acceptance Criteria**:

  - [x] `LineChunker` class exists and chunks text by lines
  - [x] `ChunkManager.chunkWithChonkie()` catches Chonkie errors and falls back to LineChunker
  - [x] Chonkie failure does NOT crash indexing — fallback works silently
  - [x] `tsc --noEmit` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Line chunker falls back gracefully when Chonkie throws
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Create a simple JS file content and verify Chonkie chunks it
      2. Verify the output structure matches CodeChunk interface
    Expected Result: Chunks returned with all required fields
    Failure Indicators: Missing fields, wrong types
    Evidence: .sisyphus/evidence/task-2-fallback.txt
  ```

  **Commit**: YES (with Task 5)

- [x] 3. Add token-based striding

  **What to do**:
  - In `packages/code-search/src/chunker/`:
    - Create `packages/code-search/src/chunker/stride.ts` utility
    - `strideChunk(chunk: CodeChunk, content: string, chunkSize: number, overlapTokens: number): CodeChunk[]`
    - Algorithm:
      1. If `chunk.tokenCount <= chunkSize`, return original chunk (no striding needed)
      2. Compute `windowChars = chunkSize * 4.0` (chars per token estimate)
      3. Compute `overlapChars = overlapTokens * 4.0`
      4. Sliding window: advance by `(windowChars - overlapChars)` chars each stride
      5. Each stride sub-chunk gets same `chunkType` as parent, `metadata.strideIndex`, `metadata.totalStrides`, `metadata.overlapStart`, `metadata.overlapEnd`
      6. First stride: `overlapStart = 0`. Last stride: `overlapEnd = chunk.endLine`
  - In `packages/code-search/src/chunker/chonkie-chunker.ts`:
    - `ChonkieExtractor.chunkFile()` applies striding to each chunk returned by Chonkie
    - Use `overlap: number` from config (default: `Math.floor(chunkSize * 0.2)` — 20%)
    - Flatten all stride sub-chunks into single array
  - Compute `overlapTokens` = `Math.floor(chunkSize * 0.2)` (default 20% overlap)
  - If chunk is smaller than `chunkSize`, return as-is (no striding)

  **Must NOT do**:
  - Do NOT stride chunks smaller than `chunkSize`
  - Do NOT add striding metadata if chunk wasn't actually stradden
  - Do NOT change total chunk count for small files (striding only on oversized chunks)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 1, 2)
  - **Blocks**: Task 5

  **References**:

  **Pattern References** (existing code to follow):
  - ck-chunk striding: `windowChars = maxTokens * 0.9 * charsPerToken`, `overlapChars = strideOverlap * charsPerToken`

  **Acceptance Criteria**:

  - [x] Large chunks (>chunkSize tokens) are split into overlapping sub-chunks
  - [x] Overlap is approximately 20% of chunk size in tokens
  - [x] Small chunks (≤chunkSize) returned unchanged
  - [x] Stride metadata added to stradden chunks
  - [x] `tsc --noEmit` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Small chunk is returned unchanged (no striding)
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Create a ChonkieExtractor with chunkSize=512
      2. Chunk a small JS function (e.g., "function foo() { return 1; }")
      3. Verify it returns 1 chunk with no stride metadata
    Expected Result: Single chunk, no striding applied
    Failure Indicators: Multiple sub-chunks, stride metadata on small chunk
    Evidence: .sisyphus/evidence/task-3-no-stride-small.txt

  Scenario: Large chunk is split into overlapping sub-chunks
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Create a ChonkieExtractor with chunkSize=512
      2. Chunk a large JS file (2000+ lines)
      3. Verify chunks have stride metadata
      4. Verify sub-chunks overlap (lines are shared)
    Expected Result: Multiple sub-chunks with strideIndex/totalStrides metadata, overlapping lines
    Failure Indicators: Single chunk returned for large file, no overlap
    Evidence: .sisyphus/evidence/task-3-stride-large.txt
  ```

  **Commit**: YES (with Task 5)

- [x] 4. Tag chunks with real chunkType

  **What to do**:
  - In `packages/code-search/src/chunker/chonkie-chunker.ts`:
    - Create `detectChunkType(content: string): ChunkType` helper function
    - Detection logic (regex-based, order matters):
      - `'function'`: matches `function\s+\w+|const\s+\w+\s*=\s*(async\s*)?\(|=>\s*{|\(\)\s*=>|\(\)\s*{` (function declarations, arrow functions, method shorthand)
      - `'class'`: matches `class\s+\w+|interface\s+\w+|type\s+\w+\s*=\s*{`
      - `'module'`: matches `import\s+|export\s+|require\(|from\s+`
      - `'file'`: if content starts with shebang `#!/`
      - `'block'`: default fallback
    - Apply `detectChunkType()` in `chunkFile()` mapping instead of hardcoded `'block'`
    - Apply same logic in `LineChunker` — use `detectChunkType()` for consistency
  - `ChunkType` already exists in `types.ts`: `'function' | 'class' | 'module' | 'block' | 'file'`

  **Must NOT do**:
  - Do NOT use AST parsing for type detection — regex heuristics only (performance)
  - Do NOT over-engineer the detection — simple regex patterns are sufficient

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 5)
  - **Blocked By**: Tasks 1, 2, 3

  **References**:

  **Pattern References** (existing code to follow):
  - `packages/code-search/src/chunker/chonkie-chunker.ts:82` — `chunkType: 'block' as const`. Replace with `detectChunkType(chunk.text)`.

  **WHY Each Reference Matters**:
  - Line 82 is where hardcoded `'block'` must be replaced with dynamic type detection.

  **Acceptance Criteria**:

  - [ ] `detectChunkType('function foo() {}')` returns `'function'`
  - [ ] `detectChunkType('class Bar {}')` returns `'class'`
  - [ ] `detectChunkType('import foo from "bar"')` returns `'module'`
  - [ ] Unknown content returns `'block'`
  - [ ] HTML/CSS files tagged as `'module'`
  - [ ] `tsc --noEmit` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Chunk type detection for function
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Run: node -e "const { detectChunkType } = require('./packages/code-search/dist/chunker/chonkie-chunker.js'); console.log(detectChunkType('function foo() { return 1; }')); console.log(detectChunkType('const bar = () => 1;')); console.log(detectChunkType('class MyClass {}')); console.log(detectChunkType('import x from y')); console.log(detectChunkType('some arbitrary text'));"
    Expected Result: function, function, class, module, block
    Failure Indicators: Wrong type returned for any case
    Evidence: .sisyphus/evidence/task-4-chunk-type.txt
  ```

  **Commit**: YES (with Task 5)

- [x] 5. Remove unused languages + final wiring

  **What to do**:
  - In `packages/code-search/src/chunker/chonkie-chunker.ts`:
    - Remove `'.py'`, `'.go'`, `'.rs'`, `'.java'`, `'.c'`, `'.cpp'` from `LANGUAGE_MAP`
    - Keep: `'.ts'`, `'.tsx'`, `'.js'`, `'.jsx'`, `'.html'`, `'.css'`
    - HTML files: map to `'html'` or `'javascript'` (Chonkie may not have HTML — if not, use text/line fallback for .html/.css)
    - If Chonkie doesn't support a language, fall back to line chunker for that file
  - In `packages/code-search/src/graph/tree-sitter-extractor.ts`:
    - Same language pruning
    - Remove unsupported languages from `LANGUAGE_MAP` and `initialize()` language list
  - In `packages/code-search/src/chunker/chunk-manager.ts`:
    - Remove `'.py'`, `'.go'`, `'.rs'`, `'.java'`, `'.c'`, `'.cpp'`, `'.h'`, `'.hpp'`, `'.json'` from scanned extensions
    - Keep: `'.ts'`, `'.tsx'`, `'.js'`, `'.jsx'`, `'.html'`, `'.css'`
  - Add `LineChunker` import and usage
  - Wire `overlap` config value through to `ChonkieExtractor` for striding
  - Verify full typecheck + build passes

  **Must NOT do**:
  - Do NOT remove HTML/CSS if they exist in your project scope
  - Do NOT change the public API of `ChunkManager`

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO — depends on Tasks 1, 2, 3, 4
  - **Blocks**: F1-F4

  **References**:

  **Pattern References** (existing code to follow):
  - `packages/code-search/src/chunker/chunk-manager.ts:50` — `extensions` set. Prune to JS/TS/HTML/CSS only.
  - `packages/code-search/src/chunker/chonkie-chunker.ts:6-17` — `LANGUAGE_MAP`. Prune to JS/TS only.

  **Acceptance Criteria**:

  - [ ] Only .ts, .tsx, .js, .jsx files scanned for indexing
  - [ ] HTML/CSS files use line chunker (no AST support needed)
  - [ ] `overlap` config value passed through to striding
  - [ ] `tsc --noEmit` passes with zero errors
  - [ ] `pnpm build` succeeds

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Only JS/TS extensions are scanned
    Tool: Bash (node -e)
    Preconditions: pnpm build completed
    Steps:
      1. Read chunk-manager source and verify extensions set only contains ts/js/tsx/jsx
    Expected Result: Extensions set contains only ts, tsx, js, jsx (and html/css if using line chunker)
    Failure Indicators: py, go, rs, java, c, cpp still in extensions
    Evidence: .sisyphus/evidence/task-5-extensions.txt

  Scenario: Full build succeeds
    Tool: Bash
    Preconditions: All prior tasks completed
    Steps:
      1. cd packages/code-search && pnpm typecheck && pnpm build
      2. Assert exit code 0
    Expected Result: Clean typecheck and build
    Failure Indicators: TypeScript errors, build failures
    Evidence: .sisyphus/evidence/task-5-build.txt
  ```

  **Commit**: YES (solo)
  - Message: `feat(chunker): scope to JS/TS only, add line fallback, wire overlap config`
  - Files: `chonkie-chunker.ts`, `tree-sitter-extractor.ts`, `chunk-manager.ts`, `line-chunker.ts`, `stride.ts`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE.

- [x] F1. **Plan Compliance Audit** — `oracle` ✅ APPROVE
- [x] F2. **Code Quality Review** — `unspecified-high` ✅ APPROVE
- [x] F3. **Manual QA** — `unspecified-high` ✅ APPROVE
- [x] F4. **Scope Fidelity Check** — `deep` ✅ APPROVE

---

## Commit Strategy

- **1**: `fix(chunker): wire maxChunkSize config to Chonkie` - chonkie-chunker.ts, tree-sitter-extractor.ts, chunk-manager.ts
- **5**: `feat(chunker): scope to JS/TS only, add line fallback, wire overlap config` - all changed files

---

## Success Criteria

### Verification Commands
```bash
cd packages/code-search && pnpm typecheck  # Expected: no errors
cd packages/code-search && pnpm build      # Expected: compiles successfully
```

### Final Checklist
- [ ] `maxChunkSize` config actually changes chunk size
- [ ] Striding splits oversized chunks with ~20% overlap
- [ ] Chunks tagged as function/class/module, not always 'block'
- [ ] WASM failure falls back to line chunker (no crash)
- [ ] Only JS/TS files indexed (HTML/CSS via line chunker)
