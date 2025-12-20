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
      deleteDocument: FunctionReference<
        "mutation",
        "internal",
        {
          collection: string;
          crdtBytes: ArrayBuffer;
          documentId: string;
          threshold?: number;
          version: number;
        },
        { compacted?: boolean; success: boolean },
        Name
      >;
      getInitialState: FunctionReference<
        "query",
        "internal",
        { collection: string },
        { checkpoint: { lastModified: number }; crdtBytes: ArrayBuffer } | null,
        Name
      >;
      insertDocument: FunctionReference<
        "mutation",
        "internal",
        {
          collection: string;
          crdtBytes: ArrayBuffer;
          documentId: string;
          threshold?: number;
          version: number;
        },
        { compacted?: boolean; success: boolean },
        Name
      >;
      recovery: FunctionReference<
        "query",
        "internal",
        { clientStateVector: ArrayBuffer; collection: string },
        { diff?: ArrayBuffer; serverStateVector: ArrayBuffer },
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
          threshold?: number;
          version: number;
        },
        { compacted?: boolean; success: boolean },
        Name
      >;
    };
  };
