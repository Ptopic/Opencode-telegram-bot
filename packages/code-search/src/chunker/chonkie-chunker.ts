import type { CodeChunk } from '../types.js';
import { v4 as uuid } from 'uuid';
import { CodeChunker } from '@chonkiejs/core';
import type { Chunk } from '@chonkiejs/core';

const LANGUAGE_MAP: Record<string, string> = {
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
};

export class ChonkieExtractor {
  private chunkers: Map<string, CodeChunker> = new Map();
  private initialized: boolean = false;
  private initError: Error | null = null;

  async initialize(): Promise<void> {
    if (this.initialized || this.initError) return;

    const languages = ['javascript', 'typescript', 'python', 'go', 'rust', 'java', 'c', 'cpp'];

    for (const lang of languages) {
      try {
        const chunker = await CodeChunker.create({
          language: lang,
          chunkSize: 2048,
        });
        this.chunkers.set(lang, chunker);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (err.message.includes('dylink') || err.message.includes('WASM')) {
          this.initError = new Error(
            `Chonkie WASM initialization failed for ${lang}. ` +
            `This usually indicates Node.js v25+ WASM compatibility issues. ` +
            `Error: ${err.message}`
          );
        } else {
          this.initError = new Error(`Chonkie failed to initialize for ${lang}: ${err.message}`);
        }
        return;
      }
    }

    this.initialized = true;
  }

  async chunkFile(content: string, filePath: string): Promise<CodeChunk[]> {
    await this.initialize();

    if (this.initError) {
      throw this.initError;
    }

    const ext = filePath.substring(filePath.lastIndexOf('.'));
    const language = LANGUAGE_MAP[ext] ?? 'javascript';
    const chunker = this.chunkers.get(language);

    if (!chunker) {
      throw new Error(`No chunker available for language: ${language}`);
    }

    const chunks: Chunk[] = chunker.chunk(content);

    return chunks.map((chunk, index) => {
      const startLine = content.substring(0, chunk.startIndex).split('\n').length;
      const endLine = content.substring(0, chunk.endIndex).split('\n').length;

      return {
        id: uuid(),
        filePath,
        content: chunk.text,
        startLine,
        endLine,
        language,
        chunkType: 'block' as const,
        fqn: undefined,
        parentId: undefined,
        metadata: {
          tokenCount: chunk.tokenCount,
          chunkIndex: index,
        },
      };
    });
  }
}
