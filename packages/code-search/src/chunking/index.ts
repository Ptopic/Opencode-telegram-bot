// Chunking is now handled by ChunkManager in ../chunker/chunk-manager.ts
// This file is kept for backward compatibility but tree-sitter chunking is deprecated

export type ParsedChunk = {
  id: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  chunkType: string;
  fqn?: string;
};

export const chunkFile = async () => {
  throw new Error('Use ChunkManager from ../chunker/chunk-manager.js instead');
};

export const chunkDirectory = async () => {
  throw new Error('Use ChunkManager from ../chunker/chunk-manager.js instead');
};

export const parseFile = async () => {
  throw new Error('Use ChunkManager from ../chunker/chunk-manager.js instead');
};

export const extractChunks = async () => {
  throw new Error('Use ChunkManager from ../chunker/chunk-manager.js instead');
};

export const getLanguageFromExtension = (ext: string): string => {
  const map: Record<string, string> = {
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
    '.h': 'c',
    '.hpp': 'cpp',
    '.json': 'json',
  };
  return map[ext] ?? 'text';
};

export const toCodeChunk = (chunk: ParsedChunk) => chunk;
