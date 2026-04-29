import type { IndexOptions, SearchOptions, ChunkingOptions, ServerConfig } from '../types.js';
import { z } from 'zod';

export const CodeChunkSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  content: z.string(),
  summary: z.string().optional(),
  startLine: z.number(),
  endLine: z.number(),
  language: z.string(),
  chunkType: z.enum(['function', 'class', 'module', 'block', 'file']),
  fqn: z.string().optional(),
  parentId: z.string().optional(),
  metadata: z.record(z.unknown()),
});

export const SearchOptionsSchema = z.object({
  limit: z.number().min(1).max(100).default(10),
  threshold: z.number().min(0).max(1).default(0.5),
  graphBoost: z.number().min(0).max(2).default(0.3),
  useGraph: z.boolean().default(true),
  useHybrid: z.boolean().default(true),
  bm25Weight: z.number().min(0).max(1).default(0.3),
  vectorWeight: z.number().min(0).max(1).default(0.5),
  graphWeight: z.number().min(0).max(1).default(0.2),
  useSummaryEmbedding: z.boolean().default(true),
  summaryWeight: z.number().min(0).max(1).default(0.3),
  filters: z.object({
    language: z.string().optional(),
    filePath: z.string().optional(),
    chunkTypes: z.array(z.enum(['function', 'class', 'module', 'block', 'file'])).optional(),
  }).optional(),
});

export const IndexOptionsSchema = z.object({
  paths: z.array(z.string()).min(1),
  extensions: z.record(z.string()).optional(),
  maxFileSize: z.number().positive().default(1024 * 1024),
  ignorePatterns: z.array(z.string()).default(['node_modules', '.git', 'dist', 'build']),
});

export const ChunkingOptionsSchema = z.object({
  maxChunkSize: z.number().min(100).max(10000).default(1000),
  overlap: z.number().min(0).max(500).default(100),
  strategy: z.literal('chonkie').default('chonkie'),
});

export const ServerConfigSchema = z.object({
  port: z.number().min(1).max(65535).default(3000),
  host: z.string().optional(),
  cors: z.boolean().default(false),
});

export interface Config {
  index: IndexOptions;
  search: SearchOptions;
  chunking: ChunkingOptions;
  server: ServerConfig;
  database: {
    uri: string;
    codeChunksTable?: string;
    dependencyGraphTable?: string;
  };
  embedder: {
    provider: 'voyage' | 'openai' | 'local';
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    batchSize?: number;
    maxRetries?: number;
    baseDelayMs?: number;
    interBatchDelayMs?: number;
  };
  watcher: {
    paths: string[];
    extensions: string[];
    debounceMs: number;
    ignorePatterns: string[];
  };
}

export const DefaultConfig: Config = {
  index: {
    paths: [],
    extensions: {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.py': 'python',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java',
      '.c': 'c',
      '.cpp': 'cpp',
      '.h': 'c',
      '.hpp': 'cpp',
      '.json': 'json',
    },
    maxFileSize: 1024 * 1024,
    ignorePatterns: ['node_modules', '.git', 'dist', 'build', '.next', '.nuxt'],
  },
  search: {
    limit: 10,
    threshold: 0.5,
    filters: {},
  },
  chunking: {
    maxChunkSize: 4000,
    overlap: 200,
    strategy: 'chonkie',
  },
  server: {
    port: 3000,
    host: 'localhost',
    cors: false,
  },
  database: {
    uri: './data/code-search.db',
    codeChunksTable: 'code_chunks',
    dependencyGraphTable: 'dependency_graph',
  },
  embedder: {
    provider: 'openai',
    model: 'text-embedding-3-large',
    apiKey: process.env.OPENAI_API_KEY,
  },
  watcher: {
    paths: [],
    extensions: ['.ts', '.js', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.json'],
    debounceMs: 500,
    ignorePatterns: ['node_modules', '.git', 'dist', 'build'],
  },
};
