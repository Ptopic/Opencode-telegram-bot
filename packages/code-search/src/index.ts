export { CodeSearchEngine } from './engine.js';
export { Database } from './db/database.js';
export { ChunkManager } from './chunker/chunk-manager.js';
export { Embedder } from './embedder/embedder.js';
export { FileWatcher } from './watcher/file-watcher.js';
export { TreeSitterExtractor } from './graph/tree-sitter-extractor.js';
export { GraphQueryManager } from './graph/query-manager.js';
export type { SearchResult, CodeChunk, ProjectStats } from './types.js';
export type {
  Node,
  Edge,
  NodeKind,
  EdgeKind,
  Language,
  Context,
  Subgraph,
  TraversalOptions,
  SearchOptions,
  SearchResult as GraphSearchResult,
  CodeBlock,
  FileRecord,
  ExtractionResult,
  UnresolvedReference,
  ExtractionError,
  GraphStats,
  SchemaVersion,
  CodeGraphConfig,
  FrameworkHint,
  TaskInput,
  BuildContextOptions,
  TaskContext,
  FindRelevantContextOptions,
} from './graph/types.js';
