import type { CodeChunk, ChunkingOptions } from '../types.js';
import type { Database } from '../db/database.js';
import { v4 as uuid } from 'uuid';
import { TreeSitterExtractor } from '../graph/tree-sitter-extractor.js';

interface ChunkManagerConfig {
  maxChunkSize: number;
  overlap: number;
  strategy: 'tree-sitter' | 'line' | 'unigram';
}

export class ChunkManager {
  private config: ChunkManagerConfig;
  private db?: Database;
  private extractor: TreeSitterExtractor;

  constructor(config: ChunkManagerConfig, db?: Database) {
    this.config = config;
    this.db = db;
    this.extractor = new TreeSitterExtractor();
  }

  async chunkFile(filePath: string): Promise<CodeChunk[]> {
    const { readFile } = await import('fs/promises');
    const content = await readFile(filePath, 'utf-8');
    const ext = filePath.substring(filePath.lastIndexOf('.'));
    const language = this.getLanguage(ext);

    if (this.config.strategy === 'tree-sitter') {
      return this.chunkWithTreeSitter(content, filePath, language);
    }

    return this.chunkByLines(content, filePath, language);
  }

  async chunkDirectory(paths: string[], options?: { ignorePatterns?: string[]; projectPath?: string }): Promise<CodeChunk[]> {
    this.currentProjectPath = options?.projectPath ?? paths[0] ?? '';
    const { readdirSync, statSync } = await import('fs');
    const { join, extname } = await import('path');
    const allChunks: CodeChunk[] = [];
    const ignoreSet = new Set(options?.ignorePatterns ?? ['node_modules', '.git', 'dist', 'build']);
    const extensions = new Set(['.ts', '.js', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.json']);

    const scanDir = async (dir: string): Promise<string[]> => {
      const files: string[] = [];
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (ignoreSet.has(entry.name)) continue;
          if (entry.isDirectory()) {
            files.push(...(await scanDir(fullPath)));
          } else if (entry.isFile() && extensions.has(extname(entry.name))) {
            files.push(fullPath);
          }
        }
      } catch {
        // skip inaccessible directories
      }
      return files;
    };

    for (const path of paths) {
      const stat = statSync(path);
      let files: string[];
      if (stat.isFile()) {
        files = [path];
      } else {
        files = await scanDir(path);
      }

      for (const file of files) {
        const chunks = await this.chunkFile(file);
        allChunks.push(...chunks);
      }
    }

    return allChunks;
  }

  private chunkByLines(content: string, filePath: string, language: string): CodeChunk[] {
    const lines = content.split('\n');
    const chunks: CodeChunk[] = [];
    let currentPos = 0;
    let currentLine = 1;

    while (currentLine <= lines.length) {
      const chunkLines: string[] = [];
      let charCount = 0;
      const startLine = currentLine;

      while (charCount < this.config.maxChunkSize && currentLine <= lines.length) {
        const line = lines[currentLine - 1] ?? '';
        chunkLines.push(line);
        charCount += line.length + 1;
        currentLine++;
      }

      const content = chunkLines.join('\n');
      chunks.push({
        id: uuid(),
        filePath,
        content,
        startLine: startLine,
        endLine: currentLine - 1,
        language,
        chunkType: 'file',
        metadata: {},
      });

      currentLine -= Math.floor(this.config.overlap / 80);
      if (currentLine <= startLine) currentLine = startLine + 1;
    }

    return chunks;
  }

  private async chunkWithTreeSitter(content: string, filePath: string, language: string): Promise<CodeChunk[]> {
    try {
      const { nodes, edges } = await this.extractor.extractGraph(filePath);

      if (nodes.length > 0 && this.db) {
        await this.db.upsertNodes(nodes, this.currentProjectPath);
        await this.db.upsertEdges(edges, this.currentProjectPath);
      }
    } catch (error) {
      console.error(`Error extracting graph from ${filePath}:`, error);
    }

    return this.chunkByLines(content, filePath, language);
  }

  private currentProjectPath: string = '';

  private getLanguage(ext: string): string {
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
  }
}
