# Jina Embed V2 Base Code Notepad

## Completion Record

### Task: Add MODEL_DIMENSIONS map to types.ts

**Completed**: Tue May 05 2026

**Changes made**:
- Added `MODEL_DIMENSIONS` map with 6 entries (jina-embeddings-v3: 1024, jina-embeddings-v2-base-code: 768, text-embedding-3-large: 3072, text-embedding-3-small: 1536, voyage-code-2: 1536, voyage-code-3: 1024)
- Added `DEFAULT_EMBEDDING_MODEL` constant
- Added `DEFAULT_EMBEDDING_DIMENSIONS` constant (derived from MODEL_DIMENSIONS)
- Changed `EMBEDDING_DIMENSIONS` to use `number` type with `@deprecated` JSDoc
- Removed `EmbeddingDimensions = 1024` type alias (as instructed)
- Added `getDimensionsForModel(model)` helper function that throws for unknown models
- Fixed pre-existing bug in routes.ts where `engine.getStats(projectPath)` was called with 1 argument but method expects 0

**Files modified**:
- `packages/code-search/src/types.ts`
- `packages/code-search/src/api/routes.ts`

**Verification**: `pnpm typecheck` passes
