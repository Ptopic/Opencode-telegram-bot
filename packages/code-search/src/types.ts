export type ChunkType = 'function' | 'class' | 'module' | 'block' | 'file';

export interface CodeChunk {
  id: string;
  filePath: string;
  content: string;
  summary?: string;
  startLine: number;
  endLine: number;
  language: string;
  chunkType: ChunkType;
  fqn?: string;
  parentId?: string;
  metadata: Record<string, unknown>;
  fileHash?: string;
  chunkHash?: string;
  /** Byte offset start in source file (from Chonkie Chunk) */
  startIndex?: number;
  /** Byte offset end in source file (from Chonkie Chunk) */
  endIndex?: number;
}

export interface DependencyEdge {
  sourceId: string;
  targetId: string;
  sourceFile: string;
  targetFile: string;
  importName?: string;
  line?: number;
}

export interface DependencyGraph {
  projectPath: string;
  edges: DependencyEdge[];
  lastUpdated: Date;
}

export interface SearchResult {
  chunk: CodeChunk;
  score: number;
  query: string;
  highlights: string[];
}

export interface ProjectStats {
  projectPath: string;
  totalChunks: number;
  totalFiles: number;
  totalLines: number;
  lastIndexed: Date;
  languages: Record<string, number>;
  indexSizeBytes: number;
}

export interface SearchOptions {
  limit?: number;
  threshold?: number;
  projectPath?: string;
  filters?: SearchFilters;
  useGraph?: boolean;
  useHybrid?: boolean;
  graphBoost?: number;
  bm25Weight?: number;
  vectorWeight?: number;
  graphWeight?: number;
  useSummaryEmbedding?: boolean;
  summaryWeight?: number;
  /** Weight for exact substring search pass. Default: 0 (disabled). Set > 0 to enable. */
  exactWeight?: number;
  /** If true, skip vector/hybrid search and use pure exact text search only. Default: false */
  exactSearch?: boolean;
}

export interface SearchFilters {
  language?: string;
  filePath?: string;
  chunkTypes?: ChunkType[];
}

export interface IndexOptions {
  paths: string[];
  extensions?: Record<string, string>;
  maxFileSize?: number;
  ignorePatterns?: string[];
  generateSummary?: boolean;
}

export interface ChunkingOptions {
  maxChunkSize?: number;
  overlap?: number;
  strategy?: 'chonkie';
}

export interface EmbedderConfig {
  provider: 'jina' | 'jina-v2' | 'voyage' | 'openai' | 'local';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  batchSize?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  interBatchDelayMs?: number;
}

export interface DatabaseConfig {
  uri: string;
  codeChunksTable?: string;
  dependencyGraphTable?: string;
}

export interface WatcherConfig {
  paths: string[];
  extensions?: string[];
  debounceMs?: number;
  ignorePatterns?: string[];
}

export type SearchMode = 'hybrid' | 'vector-graph' | 'vector-only';

export interface GlobalCodeSearchConfig {
  generateSummary?: boolean;
  searchMode?: SearchMode;
  bm25Weight?: number;
  vectorWeight?: number;
  graphWeight?: number;
  summaryWeight?: number;
}

export interface ServerConfig {
  port: number;
  host?: string;
  cors?: boolean;
}

export const MODEL_DIMENSIONS: Record<string, number> = {
  'jina-embeddings-v3': 1024,
  'jina-embeddings-v2-base-code': 768,
  'text-embedding-3-large': 3072,
  'text-embedding-3-small': 1536,
  'voyage-code-2': 1536,
  'voyage-code-3': 1024,
};

export const DEFAULT_EMBEDDING_MODEL = 'jina-embeddings-v2-base-code';

export const DEFAULT_EMBEDDING_DIMENSIONS = MODEL_DIMENSIONS[DEFAULT_EMBEDDING_MODEL]!; // 768

/**
 * @deprecated Use MODEL_DIMENSIONS or getDimensionsForModel() instead
 */
export const EMBEDDING_DIMENSIONS: number = DEFAULT_EMBEDDING_DIMENSIONS;

export function getDimensionsForModel(model: string): number {
  const dims = MODEL_DIMENSIONS[model];
  if (dims === undefined) {
    throw new Error(`Unknown embedding model: ${model}. Available: ${Object.keys(MODEL_DIMENSIONS).join(', ')}`);
  }
  return dims;
}
