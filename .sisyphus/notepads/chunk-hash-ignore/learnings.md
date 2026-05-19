# Chunk Hash Implementation Learnings

## Task: Add computeChunkHash to chunk-manager.ts

### What was done
- Added `computeChunkHash(content: string): string` method following the same pattern as `computeFileHash()`
- SHA-256 only, using `createHash('sha256').update(content).digest('hex')`
- Wired into both `chunkWithChonkie()` main path and line-chunker fallback path

### Key findings
- `CodeChunk` interface already has `chunkHash?: string` field defined in `types.ts:16`
- No need to modify types - just populate the existing field
- Pattern: `computeFileHash()` at lines 111-116 was the template to follow
- `createHash` already imported at line 7

### Changes made
- `chunk-manager.ts`:
  - Added `computeChunkHash()` private method at line 118-120
  - Added `chunk.chunkHash = this.computeChunkHash(chunk.content);` after `chunk.fileHash` assignment in main path (line 140)
  - Added same in fallback path (line 149)

### Verification
- `tsc --noEmit` passes with no errors

## Task: Add chunkHash field and getChunksByPath method

### What was done
- Added `chunkHash?: string` to `CodeChunk` interface in `types.ts`
- Added `chunkHash` to `CodeChunkRecord` interface in `database.ts`
- Added `chunkHash` column to LanceDB schema (nullable, since optional on interface)
- Added `chunkHash` to upsertChunks record mapping
- Added `getChunksByPath(path, projectPath): Promise<Map<string, string>>` method

### Key findings
- Pattern for `getChunksByPath` mirrors `getIndexedFileHashes` (lines 317-336 in database.ts)
  - Returns `Map<chunkHash, chunkId>` (fileHash→filePath was the existing pattern, but we need chunkHash→chunkId)
- `chunkHash` field is nullable in DB schema (`new Field('chunkHash', new Utf8(), true)`) since it's optional on CodeChunk
- `fileHash` was non-nullable in schema, but `chunkHash` is nullable (optional field)

### Changes made
- `types.ts` line 16: Added `chunkHash?: string` after `fileHash?: string`
- `database.ts`:
  - Line 38: Added `chunkHash?: string` to `CodeChunkRecord` interface
  - Line 100: Added `new Field('chunkHash', new Utf8(), true)` to schema (nullable)
  - Line 225: Added `chunkHash` field to upsertChunks schema
  - Line 244: Added `chunkHash: chunk.chunkHash ?? null` to records mapping
  - Lines 339-358: Added `getChunksByPath()` method

### Verification
- `tsc --noEmit` passes with no errors
- Pre-existing biome warnings in database.ts are unrelated to these changes
