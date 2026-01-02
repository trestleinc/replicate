import * as Y from "yjs";
import { isDoc, fragmentFromJSON } from "$/client/merge";

export function createInsertDelta(
  data: Record<string, unknown>,
  proseFields: Set<string>,
): Uint8Array {
  const doc = new Y.Doc();
  const fields = doc.getMap("fields");
  const meta = doc.getMap("_meta");

  doc.transact(() => {
    for (const [key, value] of Object.entries(data)) {
      if (key === "id") continue;

      if (proseFields.has(key) && isDoc(value)) {
        const fragment = new Y.XmlFragment();
        fields.set(key, fragment);
        fragmentFromJSON(fragment, value);
      } else {
        fields.set(key, value);
      }
    }

    meta.set("_created", true);
    meta.set("_createdAt", Date.now());
  });

  const update = Y.encodeStateAsUpdateV2(doc);
  doc.destroy();
  return update;
}

export function createDeleteDelta(): Uint8Array {
  const doc = new Y.Doc();
  const meta = doc.getMap("_meta");

  doc.transact(() => {
    meta.set("_deleted", true);
    meta.set("_deletedAt", Date.now());
  });

  const update = Y.encodeStateAsUpdateV2(doc);
  doc.destroy();
  return update;
}

export function createUpdateDelta(
  ydoc: Y.Doc,
  changes: Record<string, unknown>,
  proseFields: Set<string>,
): Uint8Array {
  const fields = ydoc.getMap("fields");
  const beforeVector = Y.encodeStateVector(ydoc);

  ydoc.transact(() => {
    for (const [key, value] of Object.entries(changes)) {
      if (key === "id") continue;
      if (proseFields.has(key)) continue;

      fields.set(key, value);
    }
  });

  return Y.encodeStateAsUpdateV2(ydoc, beforeVector);
}

export function hasDeleteMarker(ydoc: Y.Doc): boolean {
  const meta = ydoc.getMap("_meta");
  return meta.get("_deleted") === true;
}

export function hasCreateMarker(ydoc: Y.Doc): boolean {
  const meta = ydoc.getMap("_meta");
  return meta.get("_created") === true;
}

export function getDeletedAt(ydoc: Y.Doc): number | undefined {
  const meta = ydoc.getMap("_meta");
  const value = meta.get("_deletedAt");
  return typeof value === "number" ? value : undefined;
}

export function getCreatedAt(ydoc: Y.Doc): number | undefined {
  const meta = ydoc.getMap("_meta");
  const value = meta.get("_createdAt");
  return typeof value === "number" ? value : undefined;
}
