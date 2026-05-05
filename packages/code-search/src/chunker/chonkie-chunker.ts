import type { CodeChunk, ChunkType } from '../types.js';
import { v4 as uuid } from 'uuid';
import { CodeChunker } from '@chonkiejs/core';
import type { Chunk } from '@chonkiejs/core';
import { strideChunk } from './stride.js';

function detectChunkType(content: string): ChunkType {
  const trimmed = content.trim();

  // Check for shebang (file type)
  if (trimmed.startsWith('#!')) return 'file';

  // Check for module/import/export patterns first (order matters)
  if (/import\s+.*?\s+from\s+['"]/.test(trimmed)) return 'module';
  if (/export\s+(default\s+)?(function|class|const|let|var|type|interface)/.test(trimmed)) return 'module';
  if (/require\s*\(/.test(trimmed)) return 'module';

  // Check for class/interface/type patterns
  if (/^(class|interface|type)\s+\w+/.test(trimmed)) return 'class';

  // Check for function patterns
  if (/^(export\s+)?function\s+\w+/.test(trimmed)) return 'function';
  if (/^(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/.test(trimmed)) return 'function';
  if (/^(const|let|var)\s+\w+\s*=\s*(async\s+)?.*=>/.test(trimmed)) return 'function';
  if (/^\(\s*\)\s*=>/.test(trimmed)) return 'function';
  if (/^(async\s+)?function\s*\(/.test(trimmed)) return 'function';

  // Default fallback
  return 'block';
}

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
};

export class ChonkieExtractor {
  private chunkers: Map<string, CodeChunker> = new Map();
  private chunkSize: number;
  private overlap: number;

  constructor(chunkSize: number = 512, overlap: number = Math.floor(chunkSize * 0.2)) {
    this.chunkSize = chunkSize;
    this.overlap = overlap;
  }

  private async initialize(): Promise<void> {
    if (this.chunkers.size > 0) return;

    const languages = ['javascript', 'typescript'];

    for (const lang of languages) {
      const chunker = await CodeChunker.create({
        language: lang,
        chunkSize: this.chunkSize,
      });
      this.chunkers.set(lang, chunker);
    }
  }

  async chunkFile(content: string, filePath: string): Promise<CodeChunk[]> {
    await this.initialize();

    const ext = filePath.substring(filePath.lastIndexOf('.'));
    const language = LANGUAGE_MAP[ext] ?? 'javascript';
    const chunker = this.chunkers.get(language);

    if (!chunker) {
      throw new Error(`No chunker available for language: ${language}`);
    }

    const chunks: Chunk[] = chunker.chunk(content);

    const codeChunks: CodeChunk[] = chunks.map((chunk, index) => {
      const startLine = content.substring(0, chunk.startIndex).split('\n').length;
      const endLine = content.substring(0, chunk.endIndex).split('\n').length;

      return {
        id: uuid(),
        filePath,
        content: chunk.text,
        startLine,
        endLine,
        language,
        chunkType: detectChunkType(chunk.text),
        fqn: undefined,
        parentId: undefined,
        startIndex: chunk.startIndex,
        endIndex: chunk.endIndex,
        metadata: {
          tokenCount: chunk.tokenCount,
          chunkIndex: index,
        },
      };
    });

    return codeChunks.flatMap((chunk) =>
      strideChunk(chunk, { chunkSize: this.chunkSize, overlapTokens: this.overlap })
    );
  }
}
