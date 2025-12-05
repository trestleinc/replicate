/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    public: {
      compactCollectionByName: FunctionReference<
        "mutation",
        "internal",
        { collection: string; retentionDays?: number },
        any,
        Name
      >;
      createVersion: FunctionReference<
        "mutation",
        "internal",
        {
          collection: string;
          createdBy?: string;
          documentId: string;
          label?: string;
        },
        { createdAt: number; versionId: string },
        Name
      >;
      deleteDocument: FunctionReference<
        "mutation",
        "internal",
        {
          collection: string;
          crdtBytes: ArrayBuffer;
          documentId: string;
          version: number;
        },
        { success: boolean },
        Name
      >;
      deleteVersion: FunctionReference<
        "mutation",
        "internal",
        { versionId: string },
        { success: boolean },
        Name
      >;
      getInitialState: FunctionReference<
        "query",
        "internal",
        { collection: string },
        { checkpoint: { lastModified: number }; crdtBytes: ArrayBuffer } | null,
        Name
      >;
      getProtocolVersion: FunctionReference<
        "query",
        "internal",
        {},
        { protocolVersion: number },
        Name
      >;
      getVersion: FunctionReference<
        "query",
        "internal",
        { versionId: string },
        {
          collection: string;
          createdAt: number;
          createdBy: string | null;
          documentId: string;
          label: string | null;
          stateBytes: ArrayBuffer;
          versionId: string;
        } | null,
        Name
      >;
      insertDocument: FunctionReference<
        "mutation",
        "internal",
        {
          collection: string;
          crdtBytes: ArrayBuffer;
          documentId: string;
          version: number;
        },
        { success: boolean },
        Name
      >;
      listVersions: FunctionReference<
        "query",
        "internal",
        { collection: string; documentId: string; limit?: number },
        Array<{
          createdAt: number;
          createdBy: string | null;
          label: string | null;
          versionId: string;
        }>,
        Name
      >;
      pruneCollectionByName: FunctionReference<
        "mutation",
        "internal",
        { collection: string; retentionDays?: number },
        any,
        Name
      >;
      pruneVersions: FunctionReference<
        "mutation",
        "internal",
        {
          collection: string;
          documentId: string;
          keepCount?: number;
          retentionDays?: number;
        },
        { deletedCount: number; remainingCount: number },
        Name
      >;
      restoreVersion: FunctionReference<
        "mutation",
        "internal",
        {
          collection: string;
          createBackup?: boolean;
          documentId: string;
          versionId: string;
        },
        { backupVersionId: string | null; success: boolean },
        Name
      >;
      stream: FunctionReference<
        "query",
        "internal",
        {
          checkpoint: { lastModified: number };
          collection: string;
          limit?: number;
          vector?: ArrayBuffer;
        },
        {
          changes: Array<{
            crdtBytes: ArrayBuffer;
            documentId?: string;
            operationType: string;
            timestamp: number;
            version: number;
          }>;
          checkpoint: { lastModified: number };
          hasMore: boolean;
        },
        Name
      >;
      updateDocument: FunctionReference<
        "mutation",
        "internal",
        {
          collection: string;
          crdtBytes: ArrayBuffer;
          documentId: string;
          version: number;
        },
        { success: boolean },
        Name
      >;
    };
  };
