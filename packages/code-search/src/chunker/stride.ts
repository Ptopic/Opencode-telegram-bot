import type { CodeChunk } from '../types.js';
import { v4 as uuid } from 'uuid';

const CHARS_PER_TOKEN = 4.0;

export interface StrideOptions {
  chunkSize: number;
  overlapTokens?: number;
}

export function strideChunk(chunk: CodeChunk, options: StrideOptions): CodeChunk[] {
  const { chunkSize, overlapTokens = Math.floor(chunkSize * 0.2) } = options;

  const tokenCount = chunk.metadata?.tokenCount as number ?? chunk.content.length / CHARS_PER_TOKEN;

  if (tokenCount <= chunkSize) {
    return [chunk];
  }

  const windowChars = chunkSize * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;
  const strideChars = windowChars - overlapChars;

  const result: CodeChunk[] = [];
  let offset = chunk.startIndex ?? 0;
  const endIndex = chunk.endIndex ?? chunk.content.length;
  let strideIndex = 0;

  while (offset < endIndex) {
    const windowEnd = Math.min(offset + windowChars, endIndex);
    const relativeStart = offset - (chunk.startIndex ?? 0);
    const relativeEnd = windowEnd - (chunk.startIndex ?? 0);
    const windowContent = chunk.content.substring(relativeStart, relativeEnd);

    const isFirst = strideIndex === 0;
    const isLast = windowEnd >= endIndex;

    const strideChunk: CodeChunk = {
      ...chunk,
      id: uuid(),
      content: windowContent,
      startIndex: offset,
      endIndex: windowEnd,
      startLine: chunk.startLine + countNewlines(chunk.content, 0, relativeStart),
      endLine: chunk.startLine + countNewlines(chunk.content, 0, relativeEnd),
      metadata: {
        ...chunk.metadata,
        strideIndex,
        totalStrides: -1,
        overlapStart: isFirst ? 0 : chunk.startLine + countNewlines(chunk.content, 0, relativeStart),
        overlapEnd: isLast ? chunk.endLine : chunk.startLine + countNewlines(chunk.content, 0, relativeEnd),
      },
    };

    result.push(strideChunk);
    offset += strideChars;
    strideIndex++;
  }

  for (const sc of result) {
    sc.metadata = { ...sc.metadata, totalStrides: result.length };
  }

  return result;
}

function countNewlines(text: string, start: number, end: number): number {
  let count = 0;
  for (let i = start; i < end && i < text.length; i++) {
    if (text[i] === '\n') count++;
  }
  return count;
}