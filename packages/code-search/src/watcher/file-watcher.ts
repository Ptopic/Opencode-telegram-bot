import { EventEmitter } from 'events';
import { watch, type FSWatcher } from 'chokidar';
import type { WatcherConfig } from '../types.js';

export class FileWatcher extends EventEmitter {
  private config: WatcherConfig;
  private watcher: FSWatcher | null = null;

  constructor(config: WatcherConfig) {
    super();
    this.config = config;
  }

  start(): void {
    const ignore = this.config.ignorePatterns ?? [];
    this.watcher = watch(this.config.paths, {
      ignored: ignore,
      persistent: true,
      ignoreInitial: true,
    });

    let debounceTimers: Map<string, NodeJS.Timeout> = new Map();

    this.watcher.on('change', (path: string) => {
      const existing = debounceTimers.get(path);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        debounceTimers.delete(path);
        this.emit('change', path);
      }, this.config.debounceMs ?? 500);

      debounceTimers.set(path, timer);
    });

    this.watcher.on('add', (path: string) => {
      this.emit('add', path);
    });

    this.watcher.on('unlink', (path: string) => {
      this.emit('unlink', path);
    });

    this.watcher.on('error', (error: Error) => {
      this.emit('error', error);
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
