import type { CodeChunk } from '../types.js';

interface EmbedderConfig {
  provider: 'voyage' | 'openai' | 'local';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

interface OpenAIResponse {
  data?: Array<{ embedding: number[]; index: number }>;
  error?: { message: string };
}

export class Embedder {
  private config: EmbedderConfig;
  private apiKey: string = '';
  private model: string = 'text-embedding-3-large';
  private baseUrl: string = 'https://api.openai.com/v1';

  constructor(config: EmbedderConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    this.apiKey = this.config.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.model = this.config.model ?? 'text-embedding-3-large';

    console.log('[Embedder] provider:', this.config.provider);
    console.log('[Embedder] apiKey:', this.apiKey ? 'set' : 'MISSING');
    console.log('[Embedder] model:', this.model);
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is required for OpenAI provider');
  }

  private async embedOpenAI(texts: string[]): Promise<number[][]> {
    const results: number[][] = new Array(texts.length);
    const batchSize = 100;

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      let retries = 3;
      while (retries > 0) {
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
            throw new Error(data.error?.message ?? `HTTP ${response.status}`);
          }

          for (const item of data.data ?? []) {
            results[i + item.index] = item.embedding;
          }
          break;
        } catch (err) {
          retries--;
          if (retries === 0) throw err;
          await new Promise(r => setTimeout(r, 1000));
        }
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
