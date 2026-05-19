// Shared types for MCP server code-search integration

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

export interface SearchResult {
  chunk: CodeChunk;
  score: number;
  query: string;
  highlights: string[];
  /** Containing function/class context (when fullSection=true) */
  sectionContext?: {
    startLine: number;
    endLine: number;
    content: string;
    type: 'function' | 'class' | 'method' | 'module';
    name: string;
  };
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

export type SearchModeV2 = 'regex' | 'lexical' | 'semantic' | 'hybrid';

export interface SearchOptions {
  limit?: number;
  threshold?: number;
  projectPath?: string;
  exactSearch?: boolean;
  mode?: SearchModeV2;
  filters?: SearchFilters;
  fullSection?: boolean;
  rerank?: boolean;
  rerankModel?: string;
}

export interface SearchFilters {
  language?: string;
  filePath?: string;
  chunkTypes?: ChunkType[];
}

export interface IndexOptions {
  extensions?: Record<string, string>;
  maxFileSize?: number;
  ignorePatterns?: string[];
  generateSummary?: boolean;
}

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  filePath: string;
  line?: number;
}

export interface GraphContext {
  node: GraphNode;
  callers: GraphNode[];
  callees: GraphNode[];
}

export interface DeadCodeResult {
  id: string;
  name: string;
  filePath: string;
  type: string;
  line?: number;
}

// API response types - note: API uses 'data', 'results', and 'stats' fields
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  results?: T;
  stats?: T;
  error?: string;
}

// MCP tool input types
export interface SearchInput {
  query: string;
  projectPath?: string;
  limit?: number;
  threshold?: number;
  exactSearch?: boolean;
  mode?: SearchModeV2;
  language?: string;
  filePath?: string;
  chunkTypes?: ChunkType[];
  fullSection?: boolean;
  rerank?: boolean;
  rerankModel?: string;
}

export interface IndexInput {
  paths: string[];
  extensions?: Record<string, string>;
  maxFileSize?: number;
  ignorePatterns?: string[];
  generateSummary?: boolean;
}

export interface GraphSearchInput {
  query: string;
}

export interface GraphContextInput {
  id: string;
}

export interface GraphCallersInput {
  qualifiedName: string;
}

export interface GraphCalleesInput {
  qualifiedName: string;
}

export interface RemoveIndexInput {
  path: string;
}

export interface WatchStartInput {
  paths: string[];
}
