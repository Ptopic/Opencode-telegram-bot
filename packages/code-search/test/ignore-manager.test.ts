import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IgnoreManager } from '../src/util/ignore-manager.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

describe('IgnoreManager', () => {
  beforeEach(() => {
    try {
      rmSync('/tmp/test-ignore-mgr', { recursive: true, force: true });
    } catch {}
  });

  afterEach(() => {
    try {
      rmSync('/tmp/test-ignore-mgr', { recursive: true, force: true });
    } catch {}
  });

  describe('default patterns', () => {
    it('ignores node_modules by default', async () => {
      const mgr = await IgnoreManager.fromDirectory('/tmp/test-ignore-mgr');
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/node_modules/foo.js')).toBe(true);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/node_modules/nested/bar.js')).toBe(true);
    });

    it('ignores .git by default', async () => {
      const mgr = await IgnoreManager.fromDirectory('/tmp/test-ignore-mgr');
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/.git/config')).toBe(true);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/.git/hooks/pre-commit')).toBe(true);
    });

    it('ignores dist and build', async () => {
      const mgr = await IgnoreManager.fromDirectory('/tmp/test-ignore-mgr');
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/dist/bundle.js')).toBe(true);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/build/index.html')).toBe(true);
    });

    it('ignores lockfiles', async () => {
      const mgr = await IgnoreManager.fromDirectory('/tmp/test-ignore-mgr');
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/package-lock.json')).toBe(true);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/pnpm-lock.yaml')).toBe(true);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/yarn.lock')).toBe(true);
    });

    it('ignores coverage directory', async () => {
      const mgr = await IgnoreManager.fromDirectory('/tmp/test-ignore-mgr');
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/coverage/lcov-report/index.html')).toBe(true);
    });

    it('does not ignore regular source files', async () => {
      const mgr = await IgnoreManager.fromDirectory('/tmp/test-ignore-mgr');
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/src/index.ts')).toBe(false);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/src/utils/helpers.ts')).toBe(false);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/README.md')).toBe(false);
    });
  });

  describe('root .gitignore', () => {
    beforeEach(() => {
      mkdirSync('/tmp/test-ignore-mgr', { recursive: true });
      writeFileSync('/tmp/test-ignore-mgr/.gitignore', `
*.secret
.env.production
custom-logs/
`);
    });

    it('ignores patterns from root .gitignore', async () => {
      const mgr = await IgnoreManager.fromDirectory('/tmp/test-ignore-mgr');
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/config.secret')).toBe(true);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/.env.production')).toBe(true);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/custom-logs/debug.log')).toBe(true);
    });

    it('does not ignore source files matching no patterns', async () => {
      const mgr = await IgnoreManager.fromDirectory('/tmp/test-ignore-mgr');
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/src/index.ts')).toBe(false);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/README.md')).toBe(false);
    });
  });

  describe('nested .gitignore (monorepo scenario)', () => {
    beforeEach(() => {
      mkdirSync('/tmp/test-ignore-mgr', { recursive: true });
      writeFileSync('/tmp/test-ignore-mgr/.gitignore', `
*.custom
`);
      mkdirSync('/tmp/test-ignore-mgr/frontend', { recursive: true });
      writeFileSync('/tmp/test-ignore-mgr/frontend/.gitignore', `
*.frontend-local
webpack-output/
`);
      mkdirSync('/tmp/test-ignore-mgr/backend', { recursive: true });
      writeFileSync('/tmp/test-ignore-mgr/backend/.gitignore', `
*.backend-local
alembic/
`);
    });

    it('frontend .gitignore patterns do not leak to backend', async () => {
      const mgr = await IgnoreManager.fromDirectory('/tmp/test-ignore-mgr');
      mgr.loadGitignoreForDir('/tmp/test-ignore-mgr/frontend');
      mgr.loadGitignoreForDir('/tmp/test-ignore-mgr/backend');

      expect(mgr.isIgnored('/tmp/test-ignore-mgr/frontend/config.frontend-local')).toBe(true);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/backend/config.frontend-local')).toBe(false);

      expect(mgr.isIgnored('/tmp/test-ignore-mgr/backend/tables.backend-local')).toBe(true);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/frontend/tables.backend-local')).toBe(false);
    });

    it('.gitignore directories scoped per package', async () => {
      const mgr = await IgnoreManager.fromDirectory('/tmp/test-ignore-mgr');
      mgr.loadGitignoreForDir('/tmp/test-ignore-mgr/frontend');
      mgr.loadGitignoreForDir('/tmp/test-ignore-mgr/backend');

      expect(mgr.isIgnored('/tmp/test-ignore-mgr/frontend/webpack-output/index.html')).toBe(true);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/backend/webpack-output/index.html')).toBe(false);

      expect(mgr.isIgnored('/tmp/test-ignore-mgr/backend/alembic/001_init.sql')).toBe(true);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/frontend/alembic/001_init.sql')).toBe(false);
    });

    it('root patterns apply to all subdirs', async () => {
      const mgr = await IgnoreManager.fromDirectory('/tmp/test-ignore-mgr');
      mgr.loadGitignoreForDir('/tmp/test-ignore-mgr/frontend');
      mgr.loadGitignoreForDir('/tmp/test-ignore-mgr/backend');

      expect(mgr.isIgnored('/tmp/test-ignore-mgr/secret.custom')).toBe(true);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/frontend/nested/file.custom')).toBe(true);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/backend/nested/file.custom')).toBe(true);
    });

    it('does not ignore shared source files in sibling packages', async () => {
      const mgr = await IgnoreManager.fromDirectory('/tmp/test-ignore-mgr');
      mgr.loadGitignoreForDir('/tmp/test-ignore-mgr/frontend');
      mgr.loadGitignoreForDir('/tmp/test-ignore-mgr/backend');

      expect(mgr.isIgnored('/tmp/test-ignore-mgr/frontend/src/index.tsx')).toBe(false);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/backend/src/server.ts')).toBe(false);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/shared/helpers.ts')).toBe(false);
    });
  });

  describe('directory vs file patterns', () => {
    beforeEach(() => {
      mkdirSync('/tmp/test-ignore-mgr', { recursive: true });
      writeFileSync('/tmp/test-ignore-mgr/.gitignore', `
logs/
*.tmp
cache
`);
    });

    it('treats trailing slash as directory-only', async () => {
      const mgr = await IgnoreManager.fromDirectory('/tmp/test-ignore-mgr');
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/logs/debug.log')).toBe(true);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/app/logs/debug.log')).toBe(true);
    });

    it('ignores all matching files and directories for non-slash pattern', async () => {
      const mgr = await IgnoreManager.fromDirectory('/tmp/test-ignore-mgr');
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/cache/some.js')).toBe(true);
      expect(mgr.isIgnored('/tmp/test-ignore-mgr/cache')).toBe(true);
    });
  });

  describe('paths outside project', () => {
    it('returns false for paths outside root', async () => {
      const mgr = await IgnoreManager.fromDirectory('/tmp/test-ignore-mgr');
      expect(mgr.isIgnored('/another-project/node_modules')).toBe(false);
      expect(mgr.isIgnored('/etc/passwd')).toBe(false);
    });
  });
});
