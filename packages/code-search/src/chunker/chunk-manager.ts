import type { CodeChunk } from '../types.js';
import type { Database } from '../db/database.js';
import { TreeSitterExtractor } from '../graph/tree-sitter-extractor.js';
import { ChonkieExtractor } from './chonkie-chunker.js';
import { IgnoreManager } from '../util/ignore-manager.js';
import { createHash } from 'crypto';

interface ChunkManagerConfig {
  maxChunkSize: number;
  overlap: number;
  strategy: 'chonkie';
}

export class ChunkManager {
  private config: ChunkManagerConfig;
  private db?: Database;
  private treeSitterExtractor: TreeSitterExtractor;
  private chonkieExtractor: ChonkieExtractor;

  constructor(config: ChunkManagerConfig, db?: Database) {
    this.config = config;
    this.db = db;
    this.treeSitterExtractor = new TreeSitterExtractor();
    this.chonkieExtractor = new ChonkieExtractor();
  }

  async chunkFile(filePath: string, fileHash: string): Promise<CodeChunk[]> {
    const { readFile } = await import('fs/promises');
    const content = await readFile(filePath, 'utf-8');
    const ext = filePath.substring(filePath.lastIndexOf('.'));
    const language = this.getLanguage(ext);

    return this.chunkWithChonkie(content, filePath, language, fileHash);
  }

  async chunkDirectory(
    paths: string[],
    options?: {
      ignorePatterns?: string[];
      projectPath?: string;
      indexedFileHashes?: Map<string, string>;
      onFileSkipped?: (filePath: string, reason: string) => void;
      onFileProcessed?: (filePath: string, chunkCount: number) => void;
    }
  ): Promise<CodeChunk[]> {
    this.currentProjectPath = options?.projectPath ?? paths[0] ?? '';
    const { readdirSync, statSync } = await import('fs');
    const { join, extname } = await import('path');
    const allChunks: CodeChunk[] = [];
    const extensions = new Set(['.ts', '.js', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.json']);
    const indexedHashes = options?.indexedFileHashes ?? new Map();

    const ignoreManager = await IgnoreManager.fromDirectory(this.currentProjectPath);
    if (options?.ignorePatterns) {
      ignoreManager.addPatterns(options.ignorePatterns);
    }

    const scanDir = async (dir: string): Promise<string[]> => {
      const files: string[] = [];
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (ignoreManager.isIgnored(fullPath)) continue;
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
        const { content, hash } = await this.computeFileHash(file);
        const indexedHash = indexedHashes.get(file);

        if (indexedHash && indexedHash === hash) {
          options?.onFileSkipped?.(file, 'unchanged');
          continue;
        }

        const chunks = await this.chunkFile(file, hash);
        allChunks.push(...chunks);
        options?.onFileProcessed?.(file, chunks.length);
      }
    }

    return allChunks;
  }

  private async computeFileHash(filePath: string): Promise<{ content: string; hash: string }> {
    const { readFile } = await import('fs/promises');
    const content = await readFile(filePath, 'utf-8');
    const hash = createHash('sha256').update(content).digest('hex');
    return { content, hash };
  }

  private async chunkWithChonkie(
    content: string,
    filePath: string,
    language: string,
    fileHash: string
  ): Promise<CodeChunk[]> {
    const { nodes, edges } = await this.treeSitterExtractor.extractSymbols(filePath, content, language);

    if (nodes.length > 0 && this.db) {
      await this.db.upsertNodes(nodes, this.currentProjectPath);
      await this.db.upsertEdges(edges, this.currentProjectPath);
    }

    const chunks = await this.chonkieExtractor.chunkFile(content, filePath);

    for (const chunk of chunks) {
      chunk.fileHash = fileHash;
    }

    return chunks;
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