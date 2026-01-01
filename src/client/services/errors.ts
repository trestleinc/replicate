import { Data } from "effect";

export class SyncError extends Data.TaggedError("SyncError")<{
  readonly documentId: string;
  readonly cause: unknown;
  readonly retriable: boolean;
}> {
  get message(): string {
    return `Sync failed for document ${this.documentId}: ${String(this.cause)}`;
  }
}

export class DocumentNotRegisteredError extends Data.TaggedError("DocumentNotRegisteredError")<{
  readonly documentId: string;
}> {
  get message(): string {
    return `Document ${this.documentId} is not registered`;
  }
}

export class ActorShutdownError extends Data.TaggedError("ActorShutdownError")<{
  readonly documentId: string;
}> {
  get message(): string {
    return `Actor for document ${this.documentId} has been shut down`;
  }
}

export class ActorManagerError extends Data.TaggedError("ActorManagerError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  get message(): string {
    return `ActorManager ${this.operation} failed: ${String(this.cause)}`;
  }
}
