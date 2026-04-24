import type { CodeChunk } from '../types.js';

interface EmbedderConfig {
  provider: 'voyage' | 'openai' | 'local';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

export class Embedder {
  private config: EmbedderConfig;
  private client: unknown = null;

  constructor(config: EmbedderConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.config.provider === 'voyage') {
      const { VoyageAIClient } = await import('voyageai');
      if (!this.config.apiKey) throw new Error('VOYAGE_API_KEY is required for Voyage provider');
      this.client = new VoyageAIClient({ apiKey: this.config.apiKey });
    } else if (this.config.provider === 'openai') {
      const { OpenAI } = await import('openai');
      if (!this.config.apiKey) throw new Error('OPENAI_API_KEY is required for OpenAI provider');
      this.client = new OpenAI({ apiKey: this.config.apiKey });
    }
    // 'local' needs no client initialization
  }

  async embedChunks(chunks: CodeChunk[]): Promise<number[][]> {
    if (!this.client) await this.initialize();

    if (this.config.provider === 'voyage' && this.client) {
      const response = await (this.client as any).embed({
        model: this.config.model ?? 'voyage-code-3',
        input: chunks.map(c => c.content),
      });
      return response.data.map((d: any) => d.embedding);
    }

    if (this.config.provider === 'openai' && this.client) {
      const model = this.config.model ?? 'text-embedding-3-small';
      const response = await (this.client as any).embeddings.create({
        model,
        input: chunks.map(c => c.content),
      });
      return response.data.map((d: any) => d.embedding);
    }

    if (this.config.provider === 'local') {
      return this.embedLocal(chunks.map(c => c.content));
    }

    // Fallback: zero vectors
    return chunks.map(() => new Array(1536).fill(0));
  }

  async embedQuery(query: string): Promise<number[]> {
    if (!this.client) await this.initialize();

    if (this.config.provider === 'voyage' && this.client) {
      const response = await (this.client as any).embed({
        model: this.config.model ?? 'voyage-code-3',
        input: [query],
      });
      return response.data[0].embedding;
    }

    if (this.config.provider === 'openai' && this.client) {
      const model = this.config.model ?? 'text-embedding-3-small';
      const response = await (this.client as any).embeddings.create({
        model,
        input: [query],
      });
      return response.data[0].embedding;
    }

    if (this.config.provider === 'local') {
      return this.embedLocal([query])[0] ?? new Array(1536).fill(0);
    }

    return new Array(1536).fill(0);
  }

  /**
   * Local TF-IDF based embedding (no API required).
   * Produces fixed-dimension vectors using word frequency hashing.
   * Not as semantic as dedicated embedding models, but works offline.
   */
  private embedLocal(texts: string[]): number[][] {
    const DIM = 1536;
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
        // Deterministic hash to pick vector index
        let hash = 5381;
        for (let i = 0; i < word.length; i++) {
          hash = ((hash << 5) + hash) + word.charCodeAt(i);
        }
        const slot = Math.abs(hash) % DIM;
        vec[slot] += count / words.length;
        idx++;
      });

      // L2 normalize
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      if (norm > 0) {
        for (let i = 0; i < DIM; i++) vec[i] /= norm;
      }
      results.push(vec);
    }

    return results;
  }
}
