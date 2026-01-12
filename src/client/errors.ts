export class NetworkError extends Error {
	readonly _tag = "NetworkError" as const;
	readonly retryable = true as const;
	readonly cause: unknown;
	readonly operation: string;

	constructor(props: { operation: string; cause: unknown }) {
		super(`Network error during ${props.operation}`);
		this.name = "NetworkError";
		this.operation = props.operation;
		this.cause = props.cause;
	}
}

export class IDBError extends Error {
	readonly _tag = "IDBError" as const;
	readonly operation: "get" | "set" | "delete" | "clear";
	readonly cause: unknown;
	readonly store?: string;
	readonly key?: string;

	constructor(props: {
		operation: "get" | "set" | "delete" | "clear";
		cause: unknown;
		store?: string;
		key?: string;
	}) {
		super(`IDB ${props.operation} error${props.key ? ` for key ${props.key}` : ""}`);
		this.name = "IDBError";
		this.operation = props.operation;
		this.cause = props.cause;
		this.store = props.store;
		this.key = props.key;
	}
}

export class IDBWriteError extends Error {
	readonly _tag = "IDBWriteError" as const;
	readonly key: string;
	readonly value: unknown;
	readonly cause: unknown;

	constructor(props: { key: string; value: unknown; cause: unknown }) {
		super(`IDB write error for key ${props.key}`);
		this.name = "IDBWriteError";
		this.key = props.key;
		this.value = props.value;
		this.cause = props.cause;
	}
}

export class ReconciliationError extends Error {
	readonly _tag = "ReconciliationError" as const;
	readonly collection: string;
	readonly reason: string;
	override readonly cause?: unknown;

	constructor(props: { collection: string; reason: string; cause?: unknown }) {
		super(`Reconciliation error in ${props.collection}: ${props.reason}`);
		this.name = "ReconciliationError";
		this.collection = props.collection;
		this.reason = props.reason;
		this.cause = props.cause;
	}
}

export class ProseError extends Error {
	readonly _tag = "ProseError" as const;
	readonly document: string;
	readonly field: string;
	readonly collection: string;

	constructor(props: { document: string; field: string; collection: string }) {
		super(`Prose error for ${props.collection}/${props.document}/${props.field}`);
		this.name = "ProseError";
		this.document = props.document;
		this.field = props.field;
		this.collection = props.collection;
	}
}

export class CollectionNotReadyError extends Error {
	readonly _tag = "CollectionNotReadyError" as const;
	readonly collection: string;
	readonly reason: string;

	constructor(props: { collection: string; reason: string }) {
		super(`Collection ${props.collection} not ready: ${props.reason}`);
		this.name = "CollectionNotReadyError";
		this.collection = props.collection;
		this.reason = props.reason;
	}
}

/** Error that should not be retried (auth failures, validation errors) */
export class NonRetriableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NonRetriableError";
	}
}
