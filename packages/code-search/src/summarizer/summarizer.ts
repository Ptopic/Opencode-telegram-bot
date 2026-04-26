interface SummarizerConfig {
  provider: 'openai' | 'local';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  batchSize?: number;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message: string };
}

const DEFAULT_SUMMARY_PROMPT = `You are a code summarizer. Generate a brief 1-2 sentence summary of the following code that explains what it does. Focus on the purpose and key functionality. Do not describe implementation details.`;

export class ChunkSummarizer {
  private config: SummarizerConfig;
  private apiKey: string = '';
  private model: string = 'gpt-4o-mini';
  private baseUrl: string = 'https://api.openai.com/v1';

  constructor(config: SummarizerConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    this.apiKey = this.config.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.model = this.config.model ?? 'gpt-4o-mini';

    console.log('[ChunkSummarizer] provider:', this.config.provider);
    console.log('[ChunkSummarizer] apiKey:', this.apiKey ? 'set' : 'MISSING');
    console.log('[ChunkSummarizer] model:', this.model);

    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is required for summarization');
    }
  }

  async summarizeChunks(chunks: { content: string; filePath?: string }[]): Promise<string[]> {
    if (chunks.length === 0) return [];

    await this.initialize();

    console.log('[ChunkSummarizer] Summarizing', chunks.length, 'chunks');

    const batchSize = this.config.batchSize ?? 50;
    const summaries: string[] = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const batchSummaries = await this.summarizeBatch(batch);
      summaries.push(...batchSummaries);
      console.log(`[ChunkSummarizer] Processed ${Math.min(i + batchSize, chunks.length)}/${chunks.length}`);
    }

    return summaries;
  }

  private async summarizeBatch(
    chunks: { content: string; filePath?: string }[]
  ): Promise<string[]> {
    const systemPrompt = DEFAULT_SUMMARY_PROMPT;

    const messages = chunks.map(chunk => ({
      role: 'user' as const,
      content: this.buildPrompt(chunk.content, chunk.filePath),
    }));

    let retries = 3;
    while (retries > 0) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: 'system', content: systemPrompt },
              ...messages,
            ],
            max_tokens: 100,
            temperature: 0.3,
          }),
        });

        const data = await response.json() as OpenAIChatResponse;

        if (!response.ok || data.error) {
          throw new Error(data.error?.message ?? `HTTP ${response.status}`);
        }

        const contents = data.choices?.map(c => c.message?.content?.trim() ?? '') ?? [];
        return contents;
      } catch (err) {
        retries--;
        if (retries === 0) {
          console.error('[ChunkSummarizer] Failed after 3 retries:', err);
          return chunks.map(() => '');
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    return chunks.map(() => '');
  }

  private buildPrompt(content: string, filePath?: string): string {
    const truncated = content.length > 2000 ? content.slice(0, 2000) + '...' : content;
    return `Code${filePath ? ` from ${filePath}` : ''}:\n\`\`\`\n${truncated}\n\`\`\`\n\nBrief summary (1-2 sentences):`;
  }
}