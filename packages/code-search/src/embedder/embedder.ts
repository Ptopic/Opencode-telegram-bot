import type { CodeChunk } from '../types.js';
import { MultiProviderEmbedder, createProviderChain, type ProviderConfig } from './jina-embedder.js';
import { SemanticRetrieval, type SemanticIndex } from './semantic-retrieval.js';

export { JinaEmbedder, VoyageEmbedder, OpenAIEmbedder, LocalEmbedder, ProviderChain, createProviderChain } from './jina-embedder.js';
export { SemanticRetrieval, SemanticIndex } from './semantic-retrieval.js';
export type { EmbeddingProvider, ProviderConfig } from './jina-embedder.js';
export type { SemanticManifest, SemanticArtifact } from './semantic-retrieval.js';

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

export class Embedder {
  private config: EmbedderConfig;
  private multiProvider: MultiProviderEmbedder;
  private semanticRetrieval: SemanticRetrieval;

  constructor(config: EmbedderConfig) {
    this.config = config;
    this.multiProvider = new MultiProviderEmbedder({
      provider: config.provider,
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      batchSize: config.batchSize,
      maxRetries: config.maxRetries,
      baseDelayMs: config.baseDelayMs,
      interBatchDelayMs: config.interBatchDelayMs,
    });
    this.semanticRetrieval = new SemanticRetrieval(
      {
        model: config.model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        batchSize: config.batchSize,
        maxRetries: config.maxRetries,
        baseDelayMs: config.baseDelayMs,
        interBatchDelayMs: config.interBatchDelayMs,
      },
      './data'
    );
  }

  async initialize(): Promise<void> {
    await this.multiProvider.initialize();
    await this.semanticRetrieval.initialize();
  }

  async embedChunks(chunks: CodeChunk[]): Promise<number[][]> {
    const texts = chunks.map(c => c.content.trim() === '' ? ' ' : c.content);
    console.log('[Embedder] Total chunks:', chunks.length);
    return this.multiProvider.embedChunks(chunks);
  }

  async embedQuery(query: string): Promise<number[]> {
    return this.multiProvider.embedQueryWithFallback(query);
  }

  getSemanticRetrieval(): SemanticRetrieval {
    return this.semanticRetrieval;
  }

  getProviderName(): string {
    return this.multiProvider.providerName;
  }

  getDimensions(): number {
    return this.multiProvider.dimensions;
  }
}
