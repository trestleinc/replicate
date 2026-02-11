import type { ConvexClient } from 'convex/browser';
import type { FunctionReference } from 'convex/server';
import type { Collection } from '@tanstack/db';
import type { Persistence } from '$/client/persistence/types';
import type { DocumentManager } from '$/client/documents';
import type { AnonymousPresenceConfig, UserIdentity } from '$/client/identity';
import type { CrdtFieldInfo } from '$/shared/crdt';

interface ConvexCollectionApi {
	material: FunctionReference<'query'>;
	delta: FunctionReference<'query'>;
	replicate: FunctionReference<'mutation'>;
	presence: FunctionReference<'mutation'>;
	session: FunctionReference<'query'>;
}

export interface CollectionContext {
	collection: string;
	docManager: DocumentManager;
	client: ConvexClient;
	api: ConvexCollectionApi;
	persistence: Persistence;

	/**
	 * Unified CRDT registry - maps field names to CRDT metadata.
	 * Replaces the legacy prose-specific `fields: Set<string>`.
	 */
	crdtFields: Map<string, CrdtFieldInfo>;

	/**
	 * Resolvers for register CRDT fields.
	 * Maps field name to its conflict resolution function.
	 */
	crdtResolvers?: Map<string, (conflict: unknown) => unknown>;

	/**
	 * Legacy prose field names - maintained for backward compatibility.
	 * @deprecated Use crdtFields instead
	 */
	fields: Set<string>;

	fragmentObservers: Map<string, () => void>;
	cleanup?: () => void;
	clientId?: string;
	ref?: Collection<any>;
	synced?: Promise<void>;
	resolve?: () => void;
	actorReady?: Promise<void>;
	resolveActorReady?: () => void;
	userGetter?: () => UserIdentity | undefined;
	anonymousPresence?: AnonymousPresenceConfig;
}

const contexts = new Map<string, CollectionContext>();

export function getContext(collection: string): CollectionContext {
	const ctx = contexts.get(collection);
	if (!ctx) throw new Error(`Collection ${collection} not initialized`);
	return ctx;
}

export function hasContext(collection: string): boolean {
	return contexts.has(collection);
}

type InitContextConfig = Omit<
	CollectionContext,
	'fragmentObservers' | 'cleanup' | 'clientId' | 'ref' | 'crdtResolvers'
>;

export function initContext(config: InitContextConfig): CollectionContext {
	let resolver: () => void;
	const synced = new Promise<void>((r) => {
		resolver = r;
	});

	let actorResolver: () => void;
	const actorReady = new Promise<void>((r) => {
		actorResolver = r;
	});

	// Build resolvers map from crdtFields
	const crdtResolvers = new Map<string, (conflict: unknown) => unknown>();
	for (const [fieldName, info] of config.crdtFields) {
		if (info.type === 'register' && info.resolve) {
			crdtResolvers.set(fieldName, info.resolve);
		}
	}

	const ctx: CollectionContext = {
		...config,
		crdtResolvers,
		fragmentObservers: new Map(),
		synced,
		resolve: resolver!,
		actorReady,
		resolveActorReady: actorResolver!,
	};
	contexts.set(config.collection, ctx);
	return ctx;
}

export function deleteContext(collection: string): void {
	const ctx = contexts.get(collection);
	if (ctx) {
		// Clean up fragment observers before deleting context
		for (const [, cleanupFn] of ctx.fragmentObservers) {
			try {
				cleanupFn();
			} catch {
				// Ignore cleanup errors during context deletion
			}
		}
		ctx.fragmentObservers.clear();

		// Call the cleanup function if present
		if (ctx.cleanup) {
			try {
				ctx.cleanup();
			} catch {
				// Ignore cleanup errors during context deletion
			}
		}
	}
	contexts.delete(collection);
}

type UpdateableFields = 'clientId' | 'ref' | 'cleanup';

export function updateContext(
	collection: string,
	updates: Partial<Pick<CollectionContext, UpdateableFields>>
): CollectionContext {
	const ctx = getContext(collection);
	Object.assign(ctx, updates);
	return ctx;
}

/**
 * Validate that a field is a specific CRDT type.
 * Returns the field info if valid, undefined otherwise.
 */
export const validateCrdtField = (
	ctx: CollectionContext,
	field: string,
	expectedType: CrdtFieldInfo['type']
): CrdtFieldInfo | undefined => {
	const info = ctx.crdtFields.get(field);
	return info?.type === expectedType ? info : undefined;
};
