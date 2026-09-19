import type { ConvexClient } from 'convex/browser';
import type { Value } from 'convex/values';

export interface ConnectionOptions {
	/** Start synchronization only after connect() when set to manual. */
	networkMode?: 'auto' | 'manual';
	/** Reject local document mutations and mutable CRDT bindings. */
	readOnly?: boolean;
	/** Captured at connect time; disconnect before changing account context. */
	requestArgs?: () => Record<string, Value>;
}

const protocolKeys = new Set([
	'seq',
	'limit',
	'document',
	'vector',
	'bytes',
	'material',
	'type',
	'client',
	'action',
	'connected',
	'cursor',
	'profile',
	'user',
	'paginationOpts',
	'threshold',
	'interval',
	'timeout',
	'retain',
	'exclude',
	'collection',
]);

export function createConnection(client: ConvexClient, options: ConnectionOptions) {
	let generation = 0;
	let active = false;
	let args: Record<string, Value> = {};
	const subscriptions = new Set<() => void>();
	const stale = () => new Error('Synchronization disconnected or superseded');
	const check = (token: number) => {
		if (!active || token !== generation) throw stale();
	};
	const wrapped = new Proxy(client, {
		get(target, property) {
			if (property === 'query' || property === 'mutation') {
				return async (reference: any, protocol: any) => {
					const token = generation;
					check(token);
					const result =
						property === 'query'
							? await target.query(reference, { ...args, ...protocol })
							: await target.mutation(reference, { ...args, ...protocol });
					check(token);
					return result;
				};
			}
			if (property === 'onUpdate') {
				return (reference: any, protocol: any, callback: any, onError?: any) => {
					const token = generation;
					if (!active) return () => {};
					let listening = true;
					const stop = target.onUpdate(
						reference,
						{ ...args, ...protocol },
						(value: any) => {
							if (listening && active && token === generation) callback(value);
						},
						(error: Error) => {
							if (listening && active && token === generation) onError?.(error);
						}
					);
					const unsubscribe = () => {
						if (!listening) return;
						listening = false;
						subscriptions.delete(unsubscribe);
						stop();
					};
					subscriptions.add(unsubscribe);
					return unsubscribe;
				};
			}
			return Reflect.get(target, property, target);
		},
	});
	return {
		client: wrapped,
		get active() {
			return active;
		},
		get generation() {
			return generation;
		},
		connect() {
			if (active) return;
			const supplied = options.requestArgs?.() ?? {};
			for (const key of Object.keys(supplied)) {
				if (protocolKeys.has(key))
					throw new Error(`requestArgs cannot override protocol argument: ${key}`);
			}
			args = structuredClone(supplied);
			active = true;
		},
		disconnect() {
			active = false;
			generation++;
			for (const stop of subscriptions) stop();
		},
	};
}
