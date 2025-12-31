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
    mutations: {
      compact: FunctionReference<
        "mutation",
        "internal",
        { collection: string; document: string },
        { removed: number; retained: number; size: number; success: boolean },
        Name
      >;
      cursors: FunctionReference<
        "query",
        "internal",
        { collection: string; document: string; exclude?: string },
        Array<{
          client: string;
          cursor: { anchor: any; field?: string; head: any };
          profile?: any;
          user?: string;
        }>,
        Name
      >;
      deleteDocument: FunctionReference<
        "mutation",
        "internal",
        { bytes: ArrayBuffer; collection: string; document: string },
        { seq: number; success: boolean },
        Name
      >;
      disconnect: FunctionReference<
        "mutation",
        "internal",
        { client: string; collection: string; document: string },
        null,
        Name
      >;
      getInitialState: FunctionReference<
        "query",
        "internal",
        { collection: string },
        { bytes: ArrayBuffer; cursor: number } | null,
        Name
      >;
      insertDocument: FunctionReference<
        "mutation",
        "internal",
        { bytes: ArrayBuffer; collection: string; document: string },
        { seq: number; success: boolean },
        Name
      >;
      leave: FunctionReference<
        "mutation",
        "internal",
        { client: string; collection: string; document: string },
        null,
        Name
      >;
      mark: FunctionReference<
        "mutation",
        "internal",
        {
          client: string;
          collection: string;
          cursor?: { anchor: any; field?: string; head: any };
          document: string;
          interval?: number;
          profile?: { avatar?: string; color?: string; name?: string };
          seq?: number;
          user?: string;
          vector?: ArrayBuffer;
        },
        null,
        Name
      >;
      recovery: FunctionReference<
        "query",
        "internal",
        { collection: string; vector: ArrayBuffer },
        { cursor: number; diff?: ArrayBuffer; vector: ArrayBuffer },
        Name
      >;
      sessions: FunctionReference<
        "query",
        "internal",
        {
          collection: string;
          connected?: boolean;
          document: string;
          exclude?: string;
          group?: boolean;
        },
        Array<{
          client: string;
          cursor?: { anchor: any; field?: string; head: any };
          document: string;
          profile?: any;
          seen: number;
          user?: string;
        }>,
        Name
      >;
      stream: FunctionReference<
        "query",
        "internal",
        {
          collection: string;
          cursor: number;
          limit?: number;
          threshold?: number;
        },
        {
          changes: Array<{
            bytes: ArrayBuffer;
            document: string;
            seq: number;
            type: string;
          }>;
          compact?: string;
          cursor: number;
          more: boolean;
        },
        Name
      >;
      updateDocument: FunctionReference<
        "mutation",
        "internal",
        { bytes: ArrayBuffer; collection: string; document: string },
        { seq: number; success: boolean },
        Name
      >;
    };
  };
