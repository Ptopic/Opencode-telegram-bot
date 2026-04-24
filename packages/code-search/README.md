# @opencode-telegram/code-search

Semantic code search and RAG tool with vector embeddings, AST-aware chunking, and live file watching.

## Features

- **Semantic Search**: Embed code chunks using Voyage Code 3 (optimized for code)
- **AST-Aware Chunking**: Tree-sitter powered code parsing for intelligent chunking
- **Live Sync**: Chokidar file watching with debounced updates
- **LanceDB Storage**: Local vector database with upsert support
- **REST API**: Express.js HTTP API for search and indexing

## Tech Stack

- **TypeScript** + Express.js (HTTP API)
- **LanceDB** (vector DB, local, supports upserts)
- **Tree-sitter** (AST-aware code chunking)
- **Voyage Code 3** (embeddings, best for code)
- **Chokidar** (file watching for live sync)

## Installation

```bash
pnpm install
```

## Configuration

Create a `config.json` or pass config programmatically:

```typescript
import { CodeSearchEngine, DefaultConfig } from '@opencode-telegram/code-search';

const engine = new CodeSearchEngine({
  database: { uri: './data/code-search.db' },
  embedder: { provider: 'voyage', apiKey: 'your-api-key' },
  server: { port: 3000 },
});
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `VOYAGE_API_KEY` | Voyage AI API key for embeddings |
| `OPENAI_API_KEY` | OpenAI API key (fallback embedder) |

## Usage

### Programmatic API

```typescript
import { CodeSearchEngine } from '@opencode-telegram/code-search';

const engine = new CodeSearchEngine();
await engine.initialize();

// Index a codebase
const stats = await engine.indexPaths(['/path/to/project']);

// Search
const results = await engine.search('How does authentication work?');
console.log(results[0].chunk.content);

// Start watching for changes
engine.startWatching(['/path/to/project']);

// Cleanup
await engine.close();
```

### REST API

```bash
# Start server
pnpm start

# Index paths
curl -X POST http://localhost:3000/api/search/index \
  -H 'Content-Type: application/json' \
  -d '{"paths": ["/path/to/project"]}'

# Search
curl -X POST http://localhost:3000/api/search/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "How does authentication work?"}'

# Get stats
curl http://localhost:3000/api/search/stats

# Start watching
curl -X POST http://localhost:3000/api/search/watch/start \
  -H 'Content-Type: application/json' \
  -d '{"paths": ["/path/to/project"]}'
```

## Architecture

```
src/
├── index.ts          # Main exports
├── types.ts          # Shared interfaces
├── engine.ts         # Core search engine
├── config/           # Zod schemas & defaults
├── db/               # LanceDB wrapper
├── chunker/          # Tree-sitter / line chunking
├── embedder/         # Voyage AI embeddings
├── watcher/          # Chokidar file watcher
└── api/              # Express routes & server
```

### Core Classes

| Class | Purpose |
|-------|---------|
| `CodeSearchEngine` | Main facade - coordinates all components |
| `Database` | LanceDB operations - upsert, search, delete |
| `ChunkManager` | File parsing & chunking strategies |
| `Embedder` | Vector embedding generation |
| `FileWatcher` | Chokidar-based live sync |

## Chunking Strategies

### Tree-sitter (default)
AST-aware chunking using Tree-sitter parsers:
- JavaScript/TypeScript
- Python
- Go
- Rust
- C/C++
- JSON

### Line-based
Simple line-based chunking with overlap as fallback.

## API Reference

### CodeSearchEngine

```typescript
class CodeSearchEngine {
  initialize(): Promise<void>
  indexPaths(paths: string[], options?: IndexOptions): Promise<IndexStats>
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
  removePath(path: string): Promise<void>
  getStats(): Promise<IndexStats>
  startWatching(paths: string[]): void
  stopWatching(): void
  close(): Promise<void>
}
```

### Types

```typescript
interface CodeChunk {
  id: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  chunkType: 'function' | 'class' | 'module' | 'block' | 'file';
  fqn?: string;
  metadata: Record<string, unknown>;
}

interface SearchResult {
  chunk: CodeChunk;
  score: number;
  query: string;
  highlights: string[];
}

interface IndexStats {
  totalChunks: number;
  totalFiles: number;
  totalLines: number;
  lastUpdated: Date;
  languages: Record<string, number>;
  indexSizeBytes: number;
}
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run compiled server |
| `pnpm dev` | Run with tsx watch mode |
| `pnpm clean` | Remove `dist/` directory |
| `pnpm typecheck` | Type-check without emitting |

## License

MIT
