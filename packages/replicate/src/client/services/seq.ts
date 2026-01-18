import type { KeyValueStore } from "$/client/persistence/types";

export type Seq = number;

export interface SeqService {
	load(collection: string): Promise<Seq>;
	save(collection: string, seq: Seq): Promise<void>;
	clear(collection: string): Promise<void>;
}

export function createSeqService(kv: KeyValueStore): SeqService {
	return {
		async load(collection: string): Promise<Seq> {
			const key = `cursor:${collection}`;
			const stored = await kv.get<Seq>(key);
			return stored ?? 0;
		},

		async save(collection: string, seq: Seq): Promise<void> {
			const key = `cursor:${collection}`;
			await kv.set(key, seq);
		},

		async clear(collection: string): Promise<void> {
			const key = `cursor:${collection}`;
			await kv.del(key);
		},
	};
}
