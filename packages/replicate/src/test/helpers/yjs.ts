import * as Y from "yjs";

export const createDelta = (doc: Y.Doc): Uint8Array => {
	return Y.encodeStateAsUpdateV2(doc);
};

export const applyDelta = (doc: Y.Doc, delta: Uint8Array): void => {
	Y.applyUpdateV2(doc, delta);
};

export const createDocWithFields = (fields: Record<string, unknown>): Y.Doc => {
	const doc = new Y.Doc();
	const map = doc.getMap("fields");
	for (const [key, value] of Object.entries(fields)) {
		map.set(key, value);
	}
	return doc;
};
