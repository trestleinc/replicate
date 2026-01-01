import { Data } from "effect";

export class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly cause: unknown;
  readonly retryable: true;
  readonly operation: string;
}> {}

export class IDBError extends Data.TaggedError("IDBError")<{
  readonly operation: "get" | "set" | "delete" | "clear";
  readonly store?: string;
  readonly key?: string;
  readonly cause: unknown;
}> {}

export class IDBWriteError extends Data.TaggedError("IDBWriteError")<{
  readonly key: string;
  readonly value: unknown;
  readonly cause: unknown;
}> {}

export class ReconciliationError extends Data.TaggedError("ReconciliationError")<{
  readonly collection: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}

export class ProseError extends Data.TaggedError("ProseError")<{
  readonly document: string;
  readonly field: string;
  readonly collection: string;
}> {}

export class CollectionNotReadyError extends Data.TaggedError("CollectionNotReadyError")<{
  readonly collection: string;
  readonly reason: string;
}> {}

/** Error that should not be retried (auth failures, validation errors) */
export class NonRetriableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetriableError";
  }
}
