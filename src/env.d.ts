/**
 * Type declarations for import.meta.env
 *
 * This provides TypeScript support for environment variables accessed via import.meta.env
 * Used by both browser tests (via vitest.browser.config.ts define) and potentially Vite apps.
 */

interface ImportMetaEnv {
  readonly VITE_CONVEX_URL?: string;
  // Add other VITE_ prefixed env vars as needed
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Module declaration for y-leveldb.
 * The package has broken package.json exports, so we declare the module manually.
 */
declare module 'y-leveldb' {
  import type { AbstractLevel } from 'abstract-level';
  import type * as Y from 'yjs';

  export class LeveldbPersistence {
    constructor(location: string, options?: { level?: AbstractLevel<unknown, unknown> });
    getYDoc(docName: string): Promise<Y.Doc>;
    storeUpdate(docName: string, update: Uint8Array): Promise<void>;
    destroy(): void;
  }
}
