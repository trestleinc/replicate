/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as comments from "../comments.js";
import type * as intervals from "../intervals.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  comments: typeof comments;
  intervals: typeof intervals;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  replicate: {
    mutations: {
      compact: FunctionReference<
        "mutation",
        "internal",
        { collection: string; document: string },
        { removed: number; retained: number; size: number; success: boolean }
      >;
      deleteDocument: FunctionReference<
        "mutation",
        "internal",
        { bytes: ArrayBuffer; collection: string; document: string },
        { seq: number; success: boolean }
      >;
      disconnect: FunctionReference<
        "mutation",
        "internal",
        { client: string; collection: string; document: string },
        null
      >;
      getDocumentState: FunctionReference<
        "query",
        "internal",
        { collection: string; document: string },
        { bytes: ArrayBuffer; seq: number } | null
      >;
      insertDocument: FunctionReference<
        "mutation",
        "internal",
        { bytes: ArrayBuffer; collection: string; document: string },
        { seq: number; success: boolean }
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
        null
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
        null
      >;
      recovery: FunctionReference<
        "query",
        "internal",
        { collection: string; document: string; vector: ArrayBuffer },
        { diff?: ArrayBuffer; vector: ArrayBuffer }
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
        }>
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
        }
      >;
      updateDocument: FunctionReference<
        "mutation",
        "internal",
        { bytes: ArrayBuffer; collection: string; document: string },
        { seq: number; success: boolean }
      >;
    };
  };
};
