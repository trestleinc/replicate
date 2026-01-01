import type { GenericMutationCtx, GenericQueryCtx, GenericDataModel } from "convex/server";
import { Replicate } from "$/server/replicate";
import type { CompactionConfig } from "$/shared/types";

export interface CollectionOptions<T extends object> {
  compaction?: Partial<CompactionConfig>;
  hooks?: {
    evalRead?: (ctx: GenericQueryCtx<GenericDataModel>, collection: string) => void | Promise<void>;
    evalWrite?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
    evalRemove?: (ctx: GenericMutationCtx<GenericDataModel>, docId: string) => void | Promise<void>;
    evalMark?: (ctx: GenericMutationCtx<GenericDataModel>, client: string) => void | Promise<void>;
    evalCompact?: (
      ctx: GenericMutationCtx<GenericDataModel>,
      document: string,
    ) => void | Promise<void>;
    onStream?: (ctx: GenericQueryCtx<GenericDataModel>, result: any) => void | Promise<void>;
    onInsert?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
    onUpdate?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
    onRemove?: (ctx: GenericMutationCtx<GenericDataModel>, docId: string) => void | Promise<void>;
    transform?: (docs: T[]) => T[] | Promise<T[]>;
  };
}

function createCollection<T extends object>(
  component: any,
  name: string,
  options?: CollectionOptions<T>,
) {
  return createCollectionInternal<T>(component, name, options);
}

export const collection = {
  create: createCollection,
} as const;

function createCollectionInternal<T extends object>(
  component: any,
  name: string,
  options?: CollectionOptions<T>,
) {
  const storage = new Replicate<T>(component, name, options?.compaction);

  const hooks = options?.hooks;

  return {
    __collection: name,

    stream: storage.createStreamQuery({
      evalRead: hooks?.evalRead,
      onStream: hooks?.onStream,
    }),

    material: storage.createSSRQuery({
      evalRead: hooks?.evalRead,
      transform: hooks?.transform,
    }),

    recovery: storage.createRecoveryQuery({
      evalRead: hooks?.evalRead,
    }),

    insert: storage.createInsertMutation({
      evalWrite: hooks?.evalWrite,
      onInsert: hooks?.onInsert,
    }),

    update: storage.createUpdateMutation({
      evalWrite: hooks?.evalWrite,
      onUpdate: hooks?.onUpdate,
    }),

    remove: storage.createRemoveMutation({
      evalRemove: hooks?.evalRemove,
      onRemove: hooks?.onRemove,
    }),

    mark: storage.createMarkMutation({
      evalWrite: hooks?.evalMark,
    }),

    compact: storage.createCompactMutation({
      evalWrite: hooks?.evalCompact,
    }),

    sessions: storage.createSessionsQuery({
      evalRead: hooks?.evalRead,
    }),

    presence: storage.createPresenceMutation({
      evalWrite: hooks?.evalMark,
    }),
  };
}
