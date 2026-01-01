export {
  type ActorManager,
  type ActorManagerConfig,
  ActorManagerService,
  createActorManager,
} from "$/client/services/manager";

export {
  type DocumentActor,
  type SyncFn,
  type ActorConfig,
  type DocumentMessage,
  createDocumentActor,
} from "$/client/services/actor";

export {
  type ReplicateRuntime,
  type ReplicateServices,
  type CreateRuntimeOptions,
  createRuntime,
  releaseRuntime,
  runWithRuntime,
  runSyncWithRuntime,
} from "$/client/services/runtime";

export {
  SyncError,
  DocumentNotRegisteredError,
  ActorShutdownError,
  ActorManagerError,
} from "$/client/services/errors";
