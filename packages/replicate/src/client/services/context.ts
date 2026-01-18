import type { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import type { Collection } from "@tanstack/db";
import type { Persistence } from "$/client/persistence/types";
import type { DocumentManager } from "$/client/documents";
import type { AnonymousPresenceConfig, UserIdentity } from "$/client/identity";

interface ConvexCollectionApi {
	material: FunctionReference<"query">;
	delta: FunctionReference<"query">;
	replicate: FunctionReference<"mutation">;
	presence: FunctionReference<"mutation">;
	session: FunctionReference<"query">;
}

export interface CollectionContext {
	collection: string;
	docManager: DocumentManager;
	client: ConvexClient;
	api: ConvexCollectionApi;
	persistence: Persistence;
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
	"fragmentObservers" | "cleanup" | "clientId" | "ref"
>;

export function initContext(config: InitContextConfig): CollectionContext {
	let resolver: () => void;
	const synced = new Promise<void>(r => {
		resolver = r;
	});

	let actorResolver: () => void;
	const actorReady = new Promise<void>(r => {
		actorResolver = r;
	});

	const ctx: CollectionContext = {
		...config,
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

type UpdateableFields = "clientId" | "ref" | "cleanup";

export function updateContext(
	collection: string,
	updates: Partial<Pick<CollectionContext, UpdateableFields>>,
): CollectionContext {
	const ctx = getContext(collection);
	Object.assign(ctx, updates);
	return ctx;
}
