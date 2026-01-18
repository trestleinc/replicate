import { convexTest } from "convex-test";
import schema from "../../component/schema";
import { modules } from "../../component/test.setup";
import { api } from "../../component/_generated/api";

export const createTestContext = () => convexTest(schema, modules);

export const toArrayBuffer = (data: Uint8Array): ArrayBuffer =>
	data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

export const insertTestDeltas = async (
	t: ReturnType<typeof convexTest>,
	collection: string,
	document: string,
	count: number,
) => {
	for (let i = 0; i < count; i++) {
		await t.mutation(api.mutations.insertDocument, {
			collection,
			document,
			bytes: toArrayBuffer(new Uint8Array([i % 256])),
		});
	}
};
