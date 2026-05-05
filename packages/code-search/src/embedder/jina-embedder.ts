import type { CodeChunk } from '../types.js';
import { getDimensionsForModel, MODEL_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from '../types.js';

export interface EmbeddingProvider {
  readonly name: 'jina' | 'voyage' | 'openai' | 'local';
  readonly dimensions: number;
  readonly modelName?: string;
  embedBatch(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  healthCheck(): Promise<boolean>;
}

export interface ProviderConfig {
  provider?: 'jina' | 'jina-v2' | 'voyage' | 'openai' | 'local';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  batchSize?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  interBatchDelayMs?: number;
}

function extractRetryWaitMsFromRateLimitMessage(errorMessage: string): number | null {
  const match = errorMessage.match(/try again in (\d+)\s*ms/i);
  if (match?.[1]) return parseInt(match[1], 10);
  const secMatch = errorMessage.match(/try again in ([\d.]+)\s*s/i);
  if (secMatch?.[1]) return Math.ceil(parseFloat(secMatch[1]) * 1000);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function backoffDelay(attempt: number, baseMs: number): number {
  const exponentialDelay = baseMs * 2 ** attempt;
  const jitter = Math.random() * baseMs;
  return exponentialDelay + jitter;
}

export class JinaEmbedder implements EmbeddingProvider {
  readonly name = 'jina' as const;
  readonly modelName: string;
  private _dimensions: number;
  private apiKey: string = '';
  private model = DEFAULT_EMBEDDING_MODEL;
  private baseUrl = 'https://api.jina.ai/v1';
  private batchSize: number;
  private maxRetries: number;
  private baseDelayMs: number;
  private interBatchDelayMs: number;

  constructor(config: ProviderConfig = {}) {
    this.batchSize = config.batchSize ?? 64;
    this.maxRetries = config.maxRetries ?? 5;
    this.baseDelayMs = config.baseDelayMs ?? 2000;
    this.interBatchDelayMs = config.interBatchDelayMs ?? 100;
    if (config.model) this.model = config.model;
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    try {
      this._dimensions = getDimensionsForModel(this.model);
    } catch {
      console.warn(`[JinaEmbedder] Unknown model '${this.model}', falling back to 1024 dims`);
      this._dimensions = 1024;
    }
    this.modelName = this.model;
  }

  get dimensions(): number {
    return this._dimensions;
  }

  async initialize(apiKey?: string): Promise<void> {
    this.apiKey = apiKey ?? process.env.JINA_API_KEY ?? '';
    if (!this.apiKey) {
      throw new Error('[JinaEmbedder] JINA_API_KEY is not set');
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error('[JinaEmbedder] Not initialized. Call initialize() first.');
    }

    const results: number[][] = new Array(texts.length);
    const totalBatches = Math.ceil(texts.length / this.batchSize);

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const batchNum = Math.floor(i / this.batchSize) + 1;

      let lastError: Error | null = null;
      for (let attempt = 0; attempt < this.maxRetries; attempt++) {
        try {
          const requestBody: Record<string, unknown> = {
            model: this.model,
            input: batch,
          };
          if (this.model.includes('v3')) {
            requestBody.task = 'Retrieval';
          }
          const response = await fetch(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(requestBody),
          });

          if (!response.ok) {
            const errorBody = await response.text();
            if (response.status === 429 || errorBody.toLowerCase().includes('rate limit')) {
              const retryWait = extractRetryWaitMsFromRateLimitMessage(errorBody);
              const delay = retryWait ? retryWait + 500 : backoffDelay(attempt, this.baseDelayMs);
              console.warn(`[JinaEmbedder] Rate limit on batch ${batchNum}/${totalBatches}, attempt ${attempt + 1}/${this.maxRetries}. Waiting ${Math.round(delay)}ms...`);
              await sleep(delay);
              continue;
            }
            throw new Error(`HTTP ${response.status}: ${errorBody}`);
          }

          const data = await response.json() as { data: Array<{ embedding: number[]; index: number }> };
          for (const item of data.data ?? []) {
            results[i + item.index] = item.embedding;
          }
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (lastError.message.toLowerCase().includes('rate limit') || lastError.message.includes('429')) {
            const retryWait = extractRetryWaitMsFromRateLimitMessage(lastError.message);
            const delay = retryWait ? retryWait + 500 : backoffDelay(attempt, this.baseDelayMs);
            console.warn(`[JinaEmbedder] Rate limit error on batch ${batchNum}/${totalBatches}, attempt ${attempt + 1}/${this.maxRetries}. Waiting ${Math.round(delay)}ms...`);
            await sleep(delay);
            continue;
          }
          if (attempt < this.maxRetries - 1) {
            const delay = backoffDelay(attempt, this.baseDelayMs);
            console.warn(`[JinaEmbedder] Batch ${batchNum}/${totalBatches} failed (attempt ${attempt + 1}/${this.maxRetries}): ${lastError.message}. Retrying in ${Math.round(delay)}ms...`);
            await sleep(delay);
          }
        }
      }

      if (results[i] === undefined) {
        const errorMsg = lastError ? `[JinaEmbedder] Batch ${batchNum}/${totalBatches} failed after ${this.maxRetries} retries: ${lastError.message}` : `[JinaEmbedder] Batch ${batchNum}/${totalBatches} returned no results`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }

      if (this.interBatchDelayMs > 0 && i + this.batchSize < texts.length) {
        await sleep(this.interBatchDelayMs);
      }
    }

    return results;
  }

  async embedQuery(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0] ?? [];
  }
}

export class VoyageEmbedder implements EmbeddingProvider {
  readonly name = 'voyage' as const;
  readonly modelName: string;
  private _dimensions: number;
  private apiKey: string = '';
  private model = 'voyage-code-2';
  private baseUrl = 'https://api.voyageai.com/v1';
  private batchSize: number;
  private maxRetries: number;
  private baseDelayMs: number;
  private interBatchDelayMs: number;

  constructor(config: ProviderConfig = {}) {
    this.batchSize = config.batchSize ?? 64;
    this.maxRetries = config.maxRetries ?? 5;
    this.baseDelayMs = config.baseDelayMs ?? 2000;
    this.interBatchDelayMs = config.interBatchDelayMs ?? 100;
    if (config.model) this.model = config.model;
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    this.modelName = this.model;
    try {
      this._dimensions = getDimensionsForModel(this.model);
    } catch {
      console.warn(`[VoyageEmbedder] Unknown model '${this.model}', falling back to 1536 dims`);
      this._dimensions = 1536;
    }
  }

  get dimensions(): number {
    return this._dimensions;
  }

  async initialize(apiKey?: string): Promise<void> {
    this.apiKey = apiKey ?? process.env.VOYAGE_API_KEY ?? '';
    if (!this.apiKey) {
      throw new Error('[VoyageEmbedder] VOYAGE_API_KEY is not set');
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error('[VoyageEmbedder] Not initialized. Call initialize() first.');
    }

    const results: number[][] = new Array(texts.length);
    const totalBatches = Math.ceil(texts.length / this.batchSize);

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const batchNum = Math.floor(i / this.batchSize) + 1;

      let lastError: Error | null = null;
      for (let attempt = 0; attempt < this.maxRetries; attempt++) {
        try {
          const response = await fetch(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
              model: this.model,
              input: batch,
            }),
          });

          if (!response.ok) {
            const errorBody = await response.text();
            if (response.status === 429 || errorBody.toLowerCase().includes('rate limit')) {
              const retryWait = extractRetryWaitMsFromRateLimitMessage(errorBody);
              const delay = retryWait ? retryWait + 500 : backoffDelay(attempt, this.baseDelayMs);
              console.warn(`[VoyageEmbedder] Rate limit on batch ${batchNum}/${totalBatches}, attempt ${attempt + 1}/${this.maxRetries}. Waiting ${Math.round(delay)}ms...`);
              await sleep(delay);
              continue;
            }
            throw new Error(`HTTP ${response.status}: ${errorBody}`);
          }

          const data = await response.json() as { data: Array<{ embedding: number[]; index: number }> };
          for (const item of data.data ?? []) {
            results[i + item.index] = item.embedding;
          }
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (lastError.message.toLowerCase().includes('rate limit') || lastError.message.includes('429')) {
            const retryWait = extractRetryWaitMsFromRateLimitMessage(lastError.message);
            const delay = retryWait ? retryWait + 500 : backoffDelay(attempt, this.baseDelayMs);
            console.warn(`[VoyageEmbedder] Rate limit error on batch ${batchNum}/${totalBatches}, attempt ${attempt + 1}/${this.maxRetries}. Waiting ${Math.round(delay)}ms...`);
            await sleep(delay);
            continue;
          }
          if (attempt < this.maxRetries - 1) {
            const delay = backoffDelay(attempt, this.baseDelayMs);
            console.warn(`[VoyageEmbedder] Batch ${batchNum}/${totalBatches} failed (attempt ${attempt + 1}/${this.maxRetries}): ${lastError.message}. Retrying in ${Math.round(delay)}ms...`);
            await sleep(delay);
          }
        }
      }

      if (results[i] === undefined) {
        const errorMsg = lastError ? `[VoyageEmbedder] Batch ${batchNum}/${totalBatches} failed after ${this.maxRetries} retries: ${lastError.message}` : `[VoyageEmbedder] Batch ${batchNum}/${totalBatches} returned no results`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }

      if (this.interBatchDelayMs > 0 && i + this.batchSize < texts.length) {
        await sleep(this.interBatchDelayMs);
      }
    }

    return results;
  }

  async embedQuery(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0] ?? [];
  }
}

export class OpenAIEmbedder implements EmbeddingProvider {
  readonly name = 'openai' as const;
  readonly modelName: string;
  private _dimensions: number;
  private apiKey: string = '';
  private model = 'text-embedding-3-large';
  private baseUrl = 'https://api.openai.com/v1';
  private batchSize: number;
  private maxRetries: number;
  private baseDelayMs: number;
  private interBatchDelayMs: number;

  constructor(config: ProviderConfig = {}) {
    this.batchSize = config.batchSize ?? 64;
    this.maxRetries = config.maxRetries ?? 5;
    this.baseDelayMs = config.baseDelayMs ?? 2000;
    this.interBatchDelayMs = config.interBatchDelayMs ?? 100;
    if (config.model) this.model = config.model;
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    this.modelName = this.model;
    try {
      this._dimensions = getDimensionsForModel(this.model);
    } catch {
      console.warn(`[OpenAIEmbedder] Unknown model '${this.model}', falling back to 3072 dims`);
      this._dimensions = 3072;
    }
  }

  get dimensions(): number {
    return this._dimensions;
  }

  async initialize(apiKey?: string): Promise<void> {
    this.apiKey = apiKey ?? process.env.OPENAI_API_KEY ?? '';
    if (!this.apiKey) {
      throw new Error('[OpenAIEmbedder] OPENAI_API_KEY is not set');
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: ['health check'] }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error('[OpenAIEmbedder] Not initialized. Call initialize() first.');
    }

    const results: number[][] = new Array(texts.length);
    const totalBatches = Math.ceil(texts.length / this.batchSize);

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const batchNum = Math.floor(i / this.batchSize) + 1;

      let lastError: Error | null = null;
      for (let attempt = 0; attempt < this.maxRetries; attempt++) {
        try {
          const response = await fetch(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({ model: this.model, input: batch }),
          });

          if (!response.ok) {
            const errorBody = await response.text();
            if (response.status === 429 || errorBody.toLowerCase().includes('rate limit')) {
              const retryWait = extractRetryWaitMsFromRateLimitMessage(errorBody);
              const delay = retryWait ? retryWait + 500 : backoffDelay(attempt, this.baseDelayMs);
              console.warn(`[OpenAIEmbedder] Rate limit on batch ${batchNum}/${totalBatches}, attempt ${attempt + 1}/${this.maxRetries}. Waiting ${Math.round(delay)}ms...`);
              await sleep(delay);
              continue;
            }
            throw new Error(`HTTP ${response.status}: ${errorBody}`);
          }

          const data = await response.json() as { data: Array<{ embedding: number[]; index: number }> };
          for (const item of data.data ?? []) {
            results[i + item.index] = item.embedding;
          }
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (lastError.message.toLowerCase().includes('rate limit') || lastError.message.includes('429')) {
            const retryWait = extractRetryWaitMsFromRateLimitMessage(lastError.message);
            const delay = retryWait ? retryWait + 500 : backoffDelay(attempt, this.baseDelayMs);
            console.warn(`[OpenAIEmbedder] Rate limit error on batch ${batchNum}/${totalBatches}, attempt ${attempt + 1}/${this.maxRetries}. Waiting ${Math.round(delay)}ms...`);
            await sleep(delay);
            continue;
          }
          if (attempt < this.maxRetries - 1) {
            const delay = backoffDelay(attempt, this.baseDelayMs);
            console.warn(`[OpenAIEmbedder] Batch ${batchNum}/${totalBatches} failed (attempt ${attempt + 1}/${this.maxRetries}): ${lastError.message}. Retrying in ${Math.round(delay)}ms...`);
            await sleep(delay);
          }
        }
      }

      if (results[i] === undefined) {
        const errorMsg = lastError ? `[OpenAIEmbedder] Batch ${batchNum}/${totalBatches} failed after ${this.maxRetries} retries: ${lastError.message}` : `[OpenAIEmbedder] Batch ${batchNum}/${totalBatches} returned no results`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }

      if (this.interBatchDelayMs > 0 && i + this.batchSize < texts.length) {
        await sleep(this.interBatchDelayMs);
      }
    }

    return results;
  }

  async embedQuery(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0] ?? [];
  }
}

export class LocalEmbedder implements EmbeddingProvider {
  readonly name = 'local' as const;
  private _dimensions: number;

  constructor(dimensions: number = 3072) {
    this._dimensions = dimensions;
  }

  get dimensions(): number {
    return this._dimensions;
  }

  async initialize(): Promise<void> {}

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const DIM = this.dimensions;
    const results: number[][] = [];

    for (const text of texts) {
      const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 2);
      const freq = new Map<string, number>();
      for (const w of words) {
        freq.set(w, (freq.get(w) ?? 0) + 1);
      }

      const vec = new Array(DIM).fill(0);
      let idx = 0;
      freq.forEach((count, word) => {
        if (idx >= DIM) return;
        let hash = 5381;
        for (let i = 0; i < word.length; i++) {
          hash = ((hash << 5) + hash) + word.charCodeAt(i);
        }
        const slot = Math.abs(hash) % DIM;
        vec[slot] += count / words.length;
        idx++;
      });

      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      if (norm > 0) {
        for (let i = 0; i < DIM; i++) vec[i] /= norm;
      }
      results.push(vec);
    }

    return results;
  }

  async embedQuery(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0] ?? new Array(this.dimensions).fill(0);
  }
}

export class ProviderChain {
  private providers: EmbeddingProvider[] = [];
  private initialized: EmbeddingProvider | null = null;

  addProvider(provider: EmbeddingProvider): void {
    this.providers.push(provider);
  }

  async initialize(): Promise<void> {
    for (const provider of this.providers) {
      try {
        if ('initialize' in provider && typeof provider.initialize === 'function') {
          await (provider as any).initialize();
        }
        await provider.healthCheck();
        this.initialized = provider;
        console.log(`[ProviderChain] Primary provider: ${provider.name} model=${provider.modelName ?? 'default'} (${provider.dimensions} dimensions)`);
        return;
      } catch (err) {
        console.warn(`[ProviderChain] Provider ${provider.name} not available: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error('[ProviderChain] No embedding provider available. Tried: ' + this.providers.map(p => p.name).join(', '));
  }

  getProvider(): EmbeddingProvider {
    if (!this.initialized) {
      throw new Error('[ProviderChain] Not initialized. Call initialize() first.');
    }
    return this.initialized;
  }

  getPrimaryProviderName(): string {
    return this.providers[0]?.name ?? 'unknown';
  }
}

export function createProviderChain(config: ProviderConfig = {}): ProviderChain {
  const chain = new ProviderChain();
  chain.addProvider(new JinaEmbedder(config));
  chain.addProvider(new VoyageEmbedder(config));
  chain.addProvider(new OpenAIEmbedder(config));
  return chain;
}

export class MultiProviderEmbedder {
  private chain: ProviderChain;
  private jina: JinaEmbedder;
  private voyage: VoyageEmbedder;
  private openai: OpenAIEmbedder;
  private local: LocalEmbedder;
  private activeProvider: EmbeddingProvider | null = null;

  constructor(config: ProviderConfig = {}) {
    const resolvedConfig = { ...config };
    if (resolvedConfig.provider === 'jina-v2') {
      resolvedConfig.provider = 'jina';
      resolvedConfig.model = resolvedConfig.model ?? 'jina-embeddings-v2-base-code';
    }

    this.jina = new JinaEmbedder(resolvedConfig);
    this.voyage = new VoyageEmbedder(resolvedConfig);
    this.openai = new OpenAIEmbedder(resolvedConfig);
    this.local = new LocalEmbedder(this.jina.dimensions);

    this.chain = new ProviderChain();
    this.chain.addProvider(this.jina);
    this.chain.addProvider(this.voyage);
    this.chain.addProvider(this.openai);
  }

  async initialize(): Promise<void> {
    for (const provider of [this.jina, this.voyage, this.openai]) {
      try {
        await (provider as any).initialize?.();
        await provider.healthCheck();
        this.activeProvider = provider;
        console.log(`[MultiProviderEmbedder] Primary provider: ${provider.name} model=${provider.modelName ?? 'default'} (${provider.dimensions} dimensions)`);
        return;
      } catch (err) {
        console.warn(`[MultiProviderEmbedder] Provider ${provider.name} not available: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.warn('[MultiProviderEmbedder] No API provider available, falling back to local TF-IDF');
    this.activeProvider = this.local;
  }

  get dimensions(): number {
    return this.activeProvider?.dimensions ?? this.jina.dimensions;
  }

  get providerName(): string {
    return this.activeProvider?.name ?? 'unknown';
  }

  async embedChunks(chunks: CodeChunk[]): Promise<number[][]> {
    if (!this.activeProvider) {
      throw new Error('[MultiProviderEmbedder] Not initialized. Call initialize() first.');
    }
    const texts = chunks.map(c => c.content.trim() === '' ? ' ' : c.content);
    return this.activeProvider.embedBatch(texts);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.activeProvider) {
      throw new Error('[MultiProviderEmbedder] Not initialized. Call initialize() first.');
    }
    return this.activeProvider.embedBatch(texts);
  }

  async embedQuery(query: string): Promise<number[]> {
    if (!this.activeProvider) {
      throw new Error('[MultiProviderEmbedder] Not initialized. Call initialize() first.');
    }
    return this.activeProvider.embedQuery(query);
  }

  async embedQueryWithFallback(query: string): Promise<number[]> {
    const errors: string[] = [];

    for (const provider of [this.jina, this.voyage, this.openai, this.local]) {
      try {
        await (provider as any).initialize?.();
        if (await provider.healthCheck()) {
          this.activeProvider = provider;
          console.log(`[MultiProviderEmbedder] Fallback provider: ${provider.name}`);
          return provider.embedQuery(query);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${provider.name}: ${msg}`);
        console.warn(`[MultiProviderEmbedder] ${provider.name} failed: ${msg}`);
      }
    }

    throw new Error(`[MultiProviderEmbedder] All providers failed. Errors: ${errors.join('; ')}`);
  }
}
