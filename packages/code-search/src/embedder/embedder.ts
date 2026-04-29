import type { CodeChunk } from '../types.js';

interface EmbedderConfig {
  provider: 'voyage' | 'openai' | 'local';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  batchSize?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  interBatchDelayMs?: number;
}

interface OpenAIResponse {
  data?: Array<{ embedding: number[]; index: number }>;
  error?: { message: string };
}

function extractRetryWaitMsFromRateLimitMessage(errorMessage: string): number | null {
  const match = errorMessage.match(/try again in (\d+)\s*ms/i);
  if (match) return parseInt(match[1], 10);
  // Also handle "try again in X.Xs" format
  const secMatch = errorMessage.match(/try again in ([\d.]+)\s*s/i);
  if (secMatch) return Math.ceil(parseFloat(secMatch[1]) * 1000);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Exponential backoff with jitter: base * 2^attempt + random jitter */
function backoffDelay(attempt: number, baseMs: number): number {
  const exponentialDelay = baseMs * 2 ** attempt;
  const jitter = Math.random() * baseMs;
  return exponentialDelay + jitter;
}

export class Embedder {
  private config: EmbedderConfig;
  private apiKey: string = '';
  private model: string = 'text-embedding-3-large';
  private baseUrl: string = 'https://api.openai.com/v1';
  private batchSize: number;
  private maxRetries: number;
  private baseDelayMs: number;
  private interBatchDelayMs: number;

  constructor(config: EmbedderConfig) {
    this.config = config;
    this.batchSize = config.batchSize ?? 50;
    this.maxRetries = config.maxRetries ?? 5;
    this.baseDelayMs = config.baseDelayMs ?? 2000;
    this.interBatchDelayMs = config.interBatchDelayMs ?? 200;
  }

  async initialize(): Promise<void> {
    this.apiKey = this.config.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.model = this.config.model ?? 'text-embedding-3-large';

    console.log('[Embedder] provider:', this.config.provider);
    console.log('[Embedder] apiKey:', this.apiKey ? 'set' : 'MISSING');
    console.log('[Embedder] model:', this.model);
    console.log('[Embedder] batchSize:', this.batchSize, 'maxRetries:', this.maxRetries, 'interBatchDelayMs:', this.interBatchDelayMs);
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is required for OpenAI provider');
  }

  private async embedOpenAI(texts: string[]): Promise<number[][]> {
    const results: number[][] = new Array(texts.length);
    const totalBatches = Math.ceil(texts.length / this.batchSize);

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const batchNum = Math.floor(i / this.batchSize) + 1;

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

          const data = await response.json() as OpenAIResponse;

          if (!response.ok || data.error) {
            const errorMsg = data.error?.message ?? `HTTP ${response.status}`;

            if (response.status === 429 || errorMsg.toLowerCase().includes('rate limit')) {
              const retryWait = extractRetryWaitMsFromRateLimitMessage(errorMsg);
              const delay = retryWait
                ? retryWait + 500
                : backoffDelay(attempt, this.baseDelayMs);
              console.warn(`[Embedder] Rate limit hit on batch ${batchNum}/${totalBatches}, attempt ${attempt + 1}/${this.maxRetries}. Waiting ${Math.round(delay)}ms...`);
              await sleep(delay);
              continue;
            }

            throw new Error(errorMsg);
          }

          for (const item of data.data ?? []) {
            results[i + item.index] = item.embedding;
          }
          break;
        } catch (err) {
          if (err instanceof Error && (err.message.toLowerCase().includes('rate limit') || err.message.toLowerCase().includes('429'))) {
            const retryWait = extractRetryWaitMsFromRateLimitMessage(err.message);
            const delay = retryWait
              ? retryWait + 500
              : backoffDelay(attempt, this.baseDelayMs);
            console.warn(`[Embedder] Rate limit error on batch ${batchNum}/${totalBatches}, attempt ${attempt + 1}/${this.maxRetries}. Waiting ${Math.round(delay)}ms...`);
            await sleep(delay);
            continue;
          }

          if (attempt === this.maxRetries - 1) throw err;
          const delay = backoffDelay(attempt, this.baseDelayMs);
          console.warn(`[Embedder] Batch ${batchNum}/${totalBatches} failed (attempt ${attempt + 1}/${this.maxRetries}), retrying in ${Math.round(delay)}ms...`);
          await sleep(delay);
        }
      }

      if (this.interBatchDelayMs > 0 && i + this.batchSize < texts.length) {
        await sleep(this.interBatchDelayMs);
      }
    }

    return results;
  }

  async embedChunks(chunks: CodeChunk[]): Promise<number[][]> {
    await this.initialize();
    const texts = chunks.map(c => c.content.trim() === '' ? ' ' : c.content);
    console.log('[embedChunks] Total chunks:', chunks.length);

    if (this.config.provider === 'openai') {
      return this.embedOpenAI(texts);
    }

    if (this.config.provider === 'local') {
      return this.embedLocal(texts);
    }

    return chunks.map(() => new Array(3072).fill(0));
  }

  async embedQuery(query: string): Promise<number[]> {
    await this.initialize();
    if (this.config.provider === 'openai') {
      const results = await this.embedOpenAI([query]);
      return results[0] ?? new Array(3072).fill(0);
    }

    if (this.config.provider === 'local') {
      return this.embedLocal([query])[0] ?? new Array(3072).fill(0);
    }

    return new Array(3072).fill(0);
  }

  private embedLocal(texts: string[]): number[][] {
    const DIM = 3072;
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
}
