export type ChunkType = 'function' | 'class' | 'module' | 'block' | 'file';

export interface CodeChunk {
  id: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  chunkType: ChunkType;
  fqn?: string;
  parentId?: string;
  metadata: Record<string, unknown>;
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
  filters?: SearchFilters;
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
}

export interface ChunkingOptions {
  maxChunkSize?: number;
  overlap?: number;
  strategy?: 'tree-sitter' | 'line' | 'unigram';
}

export interface EmbedderConfig {
  provider: 'voyage' | 'openai' | 'local';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  batchSize?: number;
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

export interface ServerConfig {
  port: number;
  host?: string;
  cors?: boolean;
}

export const EMBEDDING_DIMENSIONS = 1536 as const;
export type EmbeddingDimensions = 1536;
