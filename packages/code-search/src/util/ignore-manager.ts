import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';

export interface IgnoreOptions {
  patterns: string[];
  cwd: string;
}

export class IgnoreManager {
  private rules: RegExp[] = [];

  constructor(patterns: string[] = []) {
    this.addPatterns(patterns);
  }

  static async fromDirectory(rootDir: string): Promise<IgnoreManager> {
    const manager = new IgnoreManager();

    manager.addDefaultPatterns();

    const gitignorePath = join(rootDir, '.gitignore');
    if (existsSync(gitignorePath)) {
      try {
        const gitignore = readFileSync(gitignorePath, 'utf-8');
        manager.addGitignoreRules(gitignore);
      } catch {}
    }

    const indexignorePath = join(rootDir, '.indexignore');
    if (existsSync(indexignorePath)) {
      try {
        const indexignore = readFileSync(indexignorePath, 'utf-8');
        manager.addGitignoreRules(indexignore);
      } catch {}
    }

    return manager;
  }

  private addDefaultPatterns(): void {
    this.addPatterns([
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
    ]);
  }

  addPatterns(patterns: string[]): void {
    for (const pattern of patterns) {
      if (!pattern || pattern.startsWith('#')) continue;
      const regex = this.gitignoreToRegex(pattern);
      if (regex) this.rules.push(regex);
    }
  }

  addGitignoreRules(content: string): void {
    const patterns = content.split('\n');
    this.addPatterns(patterns);
  }

  private gitignoreToRegex(pattern: string): RegExp | null {
    const p = pattern.trim();
    if (!p) return null;

    let regexStr = '';
    let i = 0;
    const len = p.length;

    const isNegated = p.startsWith('!');
    if (isNegated) return null;

    const isDirectoryOnly = p.endsWith('/');
    const pClean = isDirectoryOnly ? p.slice(0, -1) : p;

    const isNegatedPattern = pClean.startsWith('!');
    if (isNegatedPattern) return null;

    regexStr += '^';

    if (p.startsWith('/')) {
      regexStr += '';
      i++;
    } else if (p.includes('/')) {
      regexStr += '.*/';
    } else {
      regexStr += '.*/';
    }

    while (i < len) {
      const char = p[i];
      if (char === '*') {
        if (p[i + 1] === '*') {
          regexStr += '.*';
          i += 2;
          if (p[i] === '/') regexStr += '/';
        } else {
          regexStr += '[^/]*';
          i++;
        }
      } else if (char === '?') {
        regexStr += '[^/]';
        i++;
      } else if (char === '.') {
        regexStr += '\\.';
        i++;
      } else if (char === '/') {
        regexStr += '/';
        i++;
      } else {
        regexStr += char;
        i++;
      }
    }

    if (isDirectoryOnly) {
      regexStr += '(/.*)?';
    } else {
      regexStr += '(/.*)?$';
    }

    try {
      return new RegExp(regexStr);
    } catch {
      return null;
    }
  }

  isIgnored(filePath: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, '/');
    for (const rule of this.rules) {
      if (rule.test(normalizedPath)) {
        return true;
      }
    }
    return false;
  }
}
