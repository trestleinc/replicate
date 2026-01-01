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
      getDocumentState: FunctionReference<
        "query",
        "internal",
        { collection: string; document: string },
        { bytes: ArrayBuffer; seq: number } | null,
        Name
      >;
      insertDocument: FunctionReference<
        "mutation",
        "internal",
        { bytes: ArrayBuffer; collection: string; document: string },
        { seq: number; success: boolean },
        Name
      >;
      mark: FunctionReference<
        "mutation",
        "internal",
        {
          client: string;
          collection: string;
          document: string;
          seq?: number;
          vector?: ArrayBuffer;
        },
        null,
        Name
      >;
      presence: FunctionReference<
        "mutation",
        "internal",
        {
          action: "join" | "leave";
          client: string;
          collection: string;
          cursor?: { anchor: any; field?: string; head: any };
          document: string;
          interval?: number;
          profile?: { avatar?: string; color?: string; name?: string };
          user?: string;
          vector?: ArrayBuffer;
        },
        null,
        Name
      >;
      recovery: FunctionReference<
        "query",
        "internal",
        { collection: string; document: string; vector: ArrayBuffer },
        { diff?: ArrayBuffer; vector: ArrayBuffer },
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
        { collection: string; limit?: number; seq: number; threshold?: number },
        {
          changes: Array<{
            bytes: ArrayBuffer;
            document: string;
            seq: number;
            type: string;
          }>;
          compact?: { documents: Array<string> };
          more: boolean;
          seq: number;
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
