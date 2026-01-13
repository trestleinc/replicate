import { OperationType } from "./shared/types.js";
import * as convex_server4 from "convex/server";

//#region src/component/mutations.d.ts
declare namespace mutations_d_exports {
  export { OperationType, compact, deleteDocument, disconnect, getDocumentState, insertDocument, mark, presence, recovery, sessions, stream, updateDocument };
}
declare const insertDocument: convex_server4.RegisteredMutation<"public", {
  bytes: ArrayBuffer;
  collection: string;
  document: string;
}, Promise<{
  success: boolean;
  seq: number;
}>>;
declare const updateDocument: convex_server4.RegisteredMutation<"public", {
  bytes: ArrayBuffer;
  collection: string;
  document: string;
}, Promise<{
  success: boolean;
  seq: number;
}>>;
declare const deleteDocument: convex_server4.RegisteredMutation<"public", {
  bytes: ArrayBuffer;
  collection: string;
  document: string;
}, Promise<{
  success: boolean;
  seq: number;
}>>;
declare const mark: convex_server4.RegisteredMutation<"public", {
  seq?: number | undefined;
  vector?: ArrayBuffer | undefined;
  collection: string;
  document: string;
  client: string;
}, Promise<null>>;
declare const compact: convex_server4.RegisteredMutation<"public", {
  collection: string;
  document: string;
}, Promise<{
  success: boolean;
  removed: number;
  retained: number;
  size: number;
}>>;
declare const stream: convex_server4.RegisteredQuery<"public", {
  limit?: number | undefined;
  threshold?: number | undefined;
  collection: string;
  seq: number;
}, Promise<{
  changes: {
    document: any;
    bytes: any;
    seq: any;
    type: OperationType;
  }[];
  seq: number;
  more: boolean;
  compact: {
    documents: string[];
  } | undefined;
}>>;
declare const recovery: convex_server4.RegisteredQuery<"public", {
  collection: string;
  document: string;
  vector: ArrayBuffer;
}, Promise<{
  vector: ArrayBuffer;
  diff?: undefined;
} | {
  diff: ArrayBuffer | undefined;
  vector: ArrayBuffer;
}>>;
declare const getDocumentState: convex_server4.RegisteredQuery<"public", {
  collection: string;
  document: string;
}, Promise<{
  bytes: ArrayBuffer;
  seq: number;
} | null>>;
declare const sessions: convex_server4.RegisteredQuery<"public", {
  connected?: boolean | undefined;
  exclude?: string | undefined;
  group?: boolean | undefined;
  collection: string;
  document: string;
}, Promise<{
  client: any;
  document: any;
  user: any;
  profile: any;
  cursor: any;
  seen: any;
}[]>>;
declare const disconnect: convex_server4.RegisteredMutation<"public", {
  collection: string;
  document: string;
  client: string;
}, Promise<null>>;
declare const presence: convex_server4.RegisteredMutation<"public", {
  vector?: ArrayBuffer | undefined;
  user?: string | undefined;
  profile?: {
    name?: string | undefined;
    color?: string | undefined;
    avatar?: string | undefined;
  } | undefined;
  cursor?: {
    field?: string | undefined;
    anchor: any;
    head: any;
  } | undefined;
  interval?: number | undefined;
  collection: string;
  document: string;
  client: string;
  action: "join" | "leave";
}, Promise<null>>;
//#endregion
export { OperationType, compact, deleteDocument, disconnect, getDocumentState, insertDocument, mark, mutations_d_exports, presence, recovery, sessions, stream, updateDocument };