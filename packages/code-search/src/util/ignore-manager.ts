import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import ignore from 'ignore';

export interface IgnoreOptions {
  patterns: string[];
  cwd: string;
}

export class IgnoreManager {
  private dirRules: Map<string, ReturnType<typeof ignore>> = new Map();
  private _rootDir: string;
  private _loadedGitignoreDirs: Set<string> = new Set();

  constructor(rootDir: string, patterns: string[] = []) {
    const normalizedRoot = rootDir.replace(/\\/g, '/').replace(/\/+$/, '');
    this._rootDir = normalizedRoot;
    const ig = ignore().add(patterns.length > 0 ? patterns : this.getDefaultPatterns());
    this.dirRules.set(normalizedRoot, ig);
  }

  static async fromDirectory(rootDir: string): Promise<IgnoreManager> {
    const manager = new IgnoreManager(rootDir);

    const gitignorePath = join(rootDir, '.gitignore');
    if (existsSync(gitignorePath)) {
      try {
        const content = readFileSync(gitignorePath, 'utf-8');
        manager.addGitignoreRules(content);
      } catch {}
    }

    const indexignorePath = join(rootDir, '.indexignore');
    if (existsSync(indexignorePath)) {
      try {
        const content = readFileSync(indexignorePath, 'utf-8');
        manager.addGitignoreRules(content);
      } catch {}
    }

    return manager;
  }

  private getDefaultPatterns(): string[] {
    return [
      'node_modules',
      '.git',
      'dist',
      'build',
      '.next',
      '.nuxt',
      '.cache',
      '__pycache__',
      '*.pyc',
      '.DS_Store',
      'Thumbs.db',
      '.env.local',
      '.env.*.local',
      '*.log',
      'pnpm-lock.yaml',
      'package-lock.json',
      'yarn.lock',
      'coverage',
      '.nyc_output',
      '.pytest_cache',
      '.env',
      'venv',
      '.venv',
      '.turbo',
      '.vercel',
      '.netlify',
      '.serverless',
      '*.min.js',
      '*.min.css',
      '*.map',
    ];
  }

  addPatterns(patterns: string[], dirPath?: string): void {
    const normalizedDir = (dirPath ?? this._rootDir).replace(/\\/g, '/').replace(/\/+$/, '');

    let ig = this.dirRules.get(normalizedDir);
    if (!ig) {
      ig = ignore();
      this.dirRules.set(normalizedDir, ig);
    }

    ig.add(patterns);
  }

  loadGitignoreForDir(dirPath: string): void {
    const normalizedDir = dirPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (this._loadedGitignoreDirs.has(normalizedDir)) return;
    this._loadedGitignoreDirs.add(normalizedDir);

    const gitignorePath = join(dirPath, '.gitignore');
    if (existsSync(gitignorePath)) {
      try {
        const content = readFileSync(gitignorePath, 'utf-8');
        this.addGitignoreRules(content, dirPath);
      } catch {}
    }

    const indexignorePath = join(dirPath, '.indexignore');
    if (existsSync(indexignorePath)) {
      try {
        const content = readFileSync(indexignorePath, 'utf-8');
        this.addGitignoreRules(content, dirPath);
      } catch {}
    }
  }

  addGitignoreRules(content: string, dirPath?: string): void {
    const patterns = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    this.addPatterns(patterns, dirPath);
  }

  isIgnored(fullPath: string): boolean {
    const normalizedPath = fullPath.replace(/\\/g, '/');

    if (!normalizedPath.startsWith(this._rootDir + '/')) {
      return false;
    }

    const relPath = normalizedPath.slice(this._rootDir.length + 1);
    const parts = relPath.split('/');

    const rootIg = this.dirRules.get(this._rootDir);
    if (rootIg && rootIg.ignores(relPath)) {
      return true;
    }

    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      prefix = prefix ? `${prefix}/${part}` : part;
      const dirKey = `${this._rootDir}/${prefix}`;
      const ig = this.dirRules.get(dirKey);
      if (ig) {
        const relToDir = relPath.slice(prefix.length + 1);
        if (ig.ignores(relToDir)) {
          return true;
        }
      }
    }

    return false;
  }
}
