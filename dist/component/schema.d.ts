import * as convex_server11 from "convex/server";
import * as convex_values0 from "convex/values";

//#region src/component/schema.d.ts
declare const _default: convex_server11.SchemaDefinition<{
  documents: convex_server11.TableDefinition<convex_values0.VObject<{
    bytes: ArrayBuffer;
    collection: string;
    document: string;
    seq: number;
  }, {
    collection: convex_values0.VString<string, "required">;
    document: convex_values0.VString<string, "required">;
    bytes: convex_values0.VBytes<ArrayBuffer, "required">;
    seq: convex_values0.VFloat64<number, "required">;
  }, "required", "bytes" | "collection" | "document" | "seq">, {
    by_collection: ["collection", "_creationTime"];
    by_document: ["collection", "document", "_creationTime"];
    by_seq: ["collection", "seq", "_creationTime"];
  }, {}, {}>;
  snapshots: convex_server11.TableDefinition<convex_values0.VObject<{
    bytes: ArrayBuffer;
    collection: string;
    document: string;
    seq: number;
    vector: ArrayBuffer;
    created: number;
  }, {
    collection: convex_values0.VString<string, "required">;
    document: convex_values0.VString<string, "required">;
    bytes: convex_values0.VBytes<ArrayBuffer, "required">;
    vector: convex_values0.VBytes<ArrayBuffer, "required">;
    seq: convex_values0.VFloat64<number, "required">;
    created: convex_values0.VFloat64<number, "required">;
  }, "required", "bytes" | "collection" | "document" | "seq" | "vector" | "created">, {
    by_document: ["collection", "document", "_creationTime"];
  }, {}, {}>;
  sessions: convex_server11.TableDefinition<convex_values0.VObject<{
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
    timeout?: convex_values0.GenericId<"_scheduled_functions"> | undefined;
    collection: string;
    document: string;
    seq: number;
    client: string;
    connected: boolean;
    seen: number;
  }, {
    collection: convex_values0.VString<string, "required">;
    document: convex_values0.VString<string, "required">;
    client: convex_values0.VString<string, "required">;
    vector: convex_values0.VBytes<ArrayBuffer | undefined, "optional">;
    connected: convex_values0.VBoolean<boolean, "required">;
    seq: convex_values0.VFloat64<number, "required">;
    seen: convex_values0.VFloat64<number, "required">;
    user: convex_values0.VString<string | undefined, "optional">;
    profile: convex_values0.VObject<{
      name?: string | undefined;
      color?: string | undefined;
      avatar?: string | undefined;
    } | undefined, {
      name: convex_values0.VString<string | undefined, "optional">;
      color: convex_values0.VString<string | undefined, "optional">;
      avatar: convex_values0.VString<string | undefined, "optional">;
    }, "optional", "name" | "color" | "avatar">;
    cursor: convex_values0.VObject<{
      field?: string | undefined;
      anchor: any;
      head: any;
    } | undefined, {
      anchor: convex_values0.VAny<any, "required", string>;
      head: convex_values0.VAny<any, "required", string>;
      field: convex_values0.VString<string | undefined, "optional">;
    }, "optional", "anchor" | "head" | "field" | `anchor.${string}` | `head.${string}`>;
    timeout: convex_values0.VId<convex_values0.GenericId<"_scheduled_functions"> | undefined, "optional">;
  }, "required", "collection" | "document" | "seq" | "vector" | "client" | "connected" | "seen" | "user" | "profile" | "cursor" | "timeout" | "profile.name" | "profile.color" | "profile.avatar" | "cursor.anchor" | "cursor.head" | "cursor.field" | `cursor.anchor.${string}` | `cursor.head.${string}`>, {
    by_collection: ["collection", "_creationTime"];
    by_document: ["collection", "document", "_creationTime"];
    by_client: ["collection", "document", "client", "_creationTime"];
    by_connected: ["collection", "document", "connected", "_creationTime"];
  }, {}, {}>;
}, true>;
//#endregion
export { _default as default };