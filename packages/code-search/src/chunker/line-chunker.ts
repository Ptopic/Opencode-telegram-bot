import type { CodeChunk, ChunkType } from '../types.js';
import { v4 as uuid } from 'uuid';

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

export class LineChunker {
  constructor(private chunkSize: number = 512) {}

  chunkFile(content: string, filePath: string): CodeChunk[] {
    const lines = content.split('\n').filter(line => line.trim() !== '');
    if (lines.length === 0) return [];

    const result: CodeChunk[] = [];
    let currentLines: string[] = [];
    let currentCharCount = 0;
    let startLine = 1;

    const estimateTokens = (text: string): number => Math.ceil(text.length / 4.0);
    const targetChars = this.chunkSize * 4.0;

    for (const line of lines) {
      const lineWithNewline = line + '\n';
      if (currentCharCount + lineWithNewline.length > targetChars && currentLines.length > 0) {
        // Emit current chunk
        const text = currentLines.join('\n');
        const endLine = startLine + currentLines.length - 1;
        result.push({
          id: uuid(),
          filePath,
          content: text,
          startLine,
          endLine,
          language: 'text',
          chunkType: detectChunkType(text),
          fqn: undefined,
          parentId: undefined,
          metadata: { source: 'line-chunker', tokenCount: estimateTokens(text) },
        });
        startLine = endLine + 1;
        currentLines = [];
        currentCharCount = 0;
      }
      currentLines.push(line);
      currentCharCount += lineWithNewline.length;
    }

    // Emit remaining lines
    if (currentLines.length > 0) {
      const text = currentLines.join('\n');
      const endLine = startLine + currentLines.length - 1;
      result.push({
        id: uuid(),
        filePath,
        content: text,
        startLine,
        endLine,
        language: 'text',
        chunkType: detectChunkType(text),
        fqn: undefined,
        parentId: undefined,
        metadata: { source: 'line-chunker', tokenCount: estimateTokens(text) },
      });
    }

    return result;
  }
}