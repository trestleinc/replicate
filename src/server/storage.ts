import { v } from 'convex/values';
import type { GenericMutationCtx, GenericQueryCtx, GenericDataModel } from 'convex/server';
import { queryGeneric, mutationGeneric, internalMutationGeneric } from 'convex/server';

export class Replicate<T extends object> {
  constructor(
    public component: any,
    public collectionName: string
  ) {}

  createStreamQuery(opts?: {
    evalRead?: (ctx: GenericQueryCtx<GenericDataModel>, collection: string) => void | Promise<void>;
    onStream?: (ctx: GenericQueryCtx<GenericDataModel>, result: any) => void | Promise<void>;
  }) {
    const component = this.component;
    const collection = this.collectionName;

    return queryGeneric({
      args: {
        checkpoint: v.object({ lastModified: v.number() }),
        limit: v.optional(v.number()),
        vector: v.optional(v.bytes()),
      },
      returns: v.object({
        changes: v.array(
          v.object({
            documentId: v.optional(v.string()),
            crdtBytes: v.bytes(),
            version: v.number(),
            timestamp: v.number(),
            operationType: v.string(),
          })
        ),
        checkpoint: v.object({ lastModified: v.number() }),
        hasMore: v.boolean(),
      }),
      handler: async (ctx, args) => {
        if (opts?.evalRead) {
          await opts.evalRead(ctx, collection);
        }
        const result = await ctx.runQuery(component.public.stream, {
          collection,
          checkpoint: args.checkpoint,
          limit: args.limit,
          vector: args.vector,
        });

        if (opts?.onStream) {
          await opts.onStream(ctx, result);
        }

        return result;
      },
    });
  }

  createSSRQuery(opts?: {
    evalRead?: (ctx: GenericQueryCtx<GenericDataModel>, collection: string) => void | Promise<void>;
    transform?: (docs: T[]) => T[] | Promise<T[]>;
    includeCRDTState?: boolean;
  }) {
    const collection = this.collectionName;
    const component = this.component;

    return queryGeneric({
      args: {},
      returns: v.object({
        documents: v.any(),
        checkpoint: v.optional(v.object({ lastModified: v.number() })),
        count: v.number(),
        crdtBytes: v.optional(v.bytes()),
      }),
      handler: async (ctx) => {
        if (opts?.evalRead) {
          await opts.evalRead(ctx, collection);
        }
        let docs = (await ctx.db.query(collection).collect()) as T[];
        if (opts?.transform) {
          docs = await opts.transform(docs);
        }

        const latestTimestamp =
          docs.length > 0 ? Math.max(...docs.map((doc: any) => doc.timestamp || 0)) : 0;

        const response: {
          documents: T[];
          checkpoint?: { lastModified: number };
          count: number;
          crdtBytes?: ArrayBuffer;
        } = {
          documents: docs,
          checkpoint: latestTimestamp > 0 ? { lastModified: latestTimestamp } : undefined,
          count: docs.length,
        };

        if (opts?.includeCRDTState) {
          const crdtState = await ctx.runQuery(component.public.getInitialState, {
            collection,
          });

          if (crdtState) {
            response.crdtBytes = crdtState.crdtBytes;
            response.checkpoint = crdtState.checkpoint;
          }
        }
        return response;
      },
    });
  }

  createInsertMutation(opts?: {
    evalWrite?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
    onInsert?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
  }) {
    const component = this.component;
    const collection = this.collectionName;

    return mutationGeneric({
      args: {
        documentId: v.string(),
        crdtBytes: v.bytes(),
        materializedDoc: v.any(),
        version: v.number(),
      },
      returns: v.object({
        success: v.boolean(),
        metadata: v.any(),
      }),
      handler: async (ctx, args) => {
        const doc = args.materializedDoc as T;

        if (opts?.evalWrite) {
          await opts.evalWrite(ctx, doc);
        }

        await ctx.runMutation(component.public.insertDocument, {
          collection,
          documentId: args.documentId,
          crdtBytes: args.crdtBytes,
          version: args.version,
        });

        await ctx.db.insert(collection, {
          id: args.documentId,
          ...(args.materializedDoc as object),
          version: args.version,
          timestamp: Date.now(),
        });

        if (opts?.onInsert) {
          await opts.onInsert(ctx, doc);
        }

        return {
          success: true,
          metadata: {
            documentId: args.documentId,
            timestamp: Date.now(),
            version: args.version,
            collection,
          },
        };
      },
    });
  }

  createUpdateMutation(opts?: {
    evalWrite?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
    onUpdate?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
  }) {
    const component = this.component;
    const collection = this.collectionName;

    return mutationGeneric({
      args: {
        documentId: v.string(),
        crdtBytes: v.bytes(),
        materializedDoc: v.any(),
        version: v.number(),
      },
      returns: v.object({
        success: v.boolean(),
        skipped: v.optional(v.boolean()),
        metadata: v.any(),
      }),
      handler: async (ctx, args) => {
        const doc = args.materializedDoc as T;

        if (opts?.evalWrite) {
          await opts.evalWrite(ctx, doc);
        }

        await ctx.runMutation(component.public.updateDocument, {
          collection,
          documentId: args.documentId,
          crdtBytes: args.crdtBytes,
          version: args.version,
        });

        const existing = await ctx.db
          .query(collection)
          .filter((q) => q.eq(q.field('id'), args.documentId))
          .first();

        if (existing) {
          const clientVersion = args.version as number;
          const serverVersion = (existing as any).version as number;
          if (serverVersion >= clientVersion) {
            return {
              success: false,
              skipped: true,
              metadata: {
                documentId: args.documentId,
                serverVersion,
                clientVersion,
                collection,
              },
            };
          }

          await ctx.db.patch(existing._id, {
            ...(args.materializedDoc as object),
            version: args.version,
            timestamp: Date.now(),
          });
        }

        if (opts?.onUpdate) {
          await opts.onUpdate(ctx, doc);
        }

        return {
          success: true,
          metadata: {
            documentId: args.documentId,
            timestamp: Date.now(),
            version: args.version,
            collection,
          },
        };
      },
    });
  }

  createRemoveMutation(opts?: {
    evalRemove?: (ctx: GenericMutationCtx<GenericDataModel>, docId: string) => void | Promise<void>;
    onRemove?: (ctx: GenericMutationCtx<GenericDataModel>, docId: string) => void | Promise<void>;
  }) {
    const component = this.component;
    const collection = this.collectionName;

    return mutationGeneric({
      args: {
        documentId: v.string(),
        crdtBytes: v.bytes(),
        version: v.number(),
      },
      returns: v.object({
        success: v.boolean(),
        metadata: v.any(),
      }),
      handler: async (ctx, args) => {
        const documentId = args.documentId as string;
        if (opts?.evalRemove) {
          await opts.evalRemove(ctx, documentId);
        }

        await ctx.runMutation(component.public.deleteDocument, {
          collection,
          documentId: documentId,
          crdtBytes: args.crdtBytes,
          version: args.version,
        });

        const existing = await ctx.db
          .query(collection)
          .filter((q) => q.eq(q.field('id'), documentId))
          .first();

        if (existing) {
          await ctx.db.delete(existing._id);
        }

        if (opts?.onRemove) {
          await opts.onRemove(ctx, documentId);
        }

        return {
          success: true,
          metadata: {
            documentId: documentId,
            timestamp: Date.now(),
            version: args.version,
            collection,
          },
        };
      },
    });
  }

  createProtocolVersionQuery() {
    const component = this.component;

    return queryGeneric({
      args: {},
      returns: v.object({
        protocolVersion: v.number(),
      }),
      handler: async (ctx) => {
        return await ctx.runQuery(component.public.getProtocolVersion, {});
      },
    });
  }

  createCompactMutation(opts?: {
    retention?: number;
    evalCompact?: (
      ctx: GenericMutationCtx<GenericDataModel>,
      collection: string
    ) => void | Promise<void>;
    onCompact?: (ctx: GenericMutationCtx<GenericDataModel>, result: any) => void | Promise<void>;
  }) {
    const component = this.component;
    const collection = this.collectionName;
    const defaultRetention = opts?.retention ?? 90;

    return internalMutationGeneric({
      args: {
        retention: v.optional(v.number()),
      },
      returns: v.any(),
      handler: async (ctx, args) => {
        if (opts?.evalCompact) {
          await opts.evalCompact(ctx, collection);
        }
        const result = await ctx.runMutation(component.public.compactCollectionByName, {
          collection,
          retentionDays: args.retention ?? defaultRetention,
        });

        if (opts?.onCompact) {
          await opts.onCompact(ctx, result);
        }

        return result;
      },
    });
  }

  createPruneMutation(opts?: {
    retention?: number;
    evalPrune?: (
      ctx: GenericMutationCtx<GenericDataModel>,
      collection: string
    ) => void | Promise<void>;
    onPrune?: (ctx: GenericMutationCtx<GenericDataModel>, result: any) => void | Promise<void>;
  }) {
    const component = this.component;
    const collection = this.collectionName;
    const defaultRetention = opts?.retention ?? 180;

    return internalMutationGeneric({
      args: {
        retention: v.optional(v.number()),
      },
      returns: v.any(),
      handler: async (ctx, args) => {
        if (opts?.evalPrune) {
          await opts.evalPrune(ctx, collection);
        }

        const result = await ctx.runMutation(component.public.pruneCollectionByName, {
          collection,
          retentionDays: args.retention ?? defaultRetention,
        });

        if (opts?.onPrune) {
          await opts.onPrune(ctx, result);
        }

        return result;
      },
    });
  }

  // ============================================================================
  // Version History Methods
  // ============================================================================

  createVersionMutation(opts?: {
    evalVersion?: (
      ctx: GenericMutationCtx<GenericDataModel>,
      collection: string,
      documentId: string
    ) => void | Promise<void>;
    onVersion?: (ctx: GenericMutationCtx<GenericDataModel>, result: any) => void | Promise<void>;
  }) {
    const component = this.component;
    const collection = this.collectionName;

    return mutationGeneric({
      args: {
        documentId: v.string(),
        label: v.optional(v.string()),
        createdBy: v.optional(v.string()),
      },
      returns: v.object({
        versionId: v.string(),
        createdAt: v.number(),
      }),
      handler: async (ctx, args) => {
        if (opts?.evalVersion) {
          await opts.evalVersion(ctx, collection, args.documentId);
        }

        const result = await ctx.runMutation(component.public.createVersion, {
          collection,
          documentId: args.documentId,
          label: args.label,
          createdBy: args.createdBy,
        });

        if (opts?.onVersion) {
          await opts.onVersion(ctx, result);
        }

        return result;
      },
    });
  }

  createListVersionsQuery(opts?: {
    evalRead?: (ctx: GenericQueryCtx<GenericDataModel>, collection: string) => void | Promise<void>;
  }) {
    const component = this.component;
    const collection = this.collectionName;

    return queryGeneric({
      args: {
        documentId: v.string(),
        limit: v.optional(v.number()),
      },
      returns: v.array(
        v.object({
          versionId: v.string(),
          label: v.union(v.string(), v.null()),
          createdAt: v.number(),
          createdBy: v.union(v.string(), v.null()),
        })
      ),
      handler: async (ctx, args) => {
        if (opts?.evalRead) {
          await opts.evalRead(ctx, collection);
        }

        return await ctx.runQuery(component.public.listVersions, {
          collection,
          documentId: args.documentId,
          limit: args.limit,
        });
      },
    });
  }

  createGetVersionQuery(opts?: {
    evalRead?: (ctx: GenericQueryCtx<GenericDataModel>, collection: string) => void | Promise<void>;
  }) {
    const component = this.component;
    const collection = this.collectionName;

    return queryGeneric({
      args: {
        versionId: v.string(),
      },
      returns: v.union(
        v.object({
          versionId: v.string(),
          collection: v.string(),
          documentId: v.string(),
          stateBytes: v.bytes(),
          label: v.union(v.string(), v.null()),
          createdAt: v.number(),
          createdBy: v.union(v.string(), v.null()),
        }),
        v.null()
      ),
      handler: async (ctx, args) => {
        if (opts?.evalRead) {
          await opts.evalRead(ctx, collection);
        }

        return await ctx.runQuery(component.public.getVersion, {
          versionId: args.versionId,
        });
      },
    });
  }

  createRestoreVersionMutation(opts?: {
    evalRestore?: (
      ctx: GenericMutationCtx<GenericDataModel>,
      collection: string,
      documentId: string,
      versionId: string
    ) => void | Promise<void>;
    onRestore?: (ctx: GenericMutationCtx<GenericDataModel>, result: any) => void | Promise<void>;
  }) {
    const component = this.component;
    const collection = this.collectionName;

    return mutationGeneric({
      args: {
        documentId: v.string(),
        versionId: v.string(),
        createBackup: v.optional(v.boolean()),
      },
      returns: v.object({
        success: v.boolean(),
        backupVersionId: v.union(v.string(), v.null()),
      }),
      handler: async (ctx, args) => {
        if (opts?.evalRestore) {
          await opts.evalRestore(ctx, collection, args.documentId, args.versionId);
        }

        const result = await ctx.runMutation(component.public.restoreVersion, {
          collection,
          documentId: args.documentId,
          versionId: args.versionId,
          createBackup: args.createBackup,
        });

        if (opts?.onRestore) {
          await opts.onRestore(ctx, result);
        }

        return result;
      },
    });
  }

  createDeleteVersionMutation(opts?: {
    evalDelete?: (
      ctx: GenericMutationCtx<GenericDataModel>,
      versionId: string
    ) => void | Promise<void>;
    onDelete?: (ctx: GenericMutationCtx<GenericDataModel>, result: any) => void | Promise<void>;
  }) {
    const component = this.component;

    return mutationGeneric({
      args: {
        versionId: v.string(),
      },
      returns: v.object({
        success: v.boolean(),
      }),
      handler: async (ctx, args) => {
        if (opts?.evalDelete) {
          await opts.evalDelete(ctx, args.versionId);
        }

        const result = await ctx.runMutation(component.public.deleteVersion, {
          versionId: args.versionId,
        });

        if (opts?.onDelete) {
          await opts.onDelete(ctx, result);
        }

        return result;
      },
    });
  }

  createPruneVersionsMutation(opts?: {
    keepCount?: number;
    retentionDays?: number;
    evalPrune?: (
      ctx: GenericMutationCtx<GenericDataModel>,
      collection: string,
      documentId: string
    ) => void | Promise<void>;
    onPrune?: (ctx: GenericMutationCtx<GenericDataModel>, result: any) => void | Promise<void>;
  }) {
    const component = this.component;
    const collection = this.collectionName;
    const defaultKeepCount = opts?.keepCount ?? 10;
    const defaultRetentionDays = opts?.retentionDays ?? 90;

    return mutationGeneric({
      args: {
        documentId: v.string(),
        keepCount: v.optional(v.number()),
        retentionDays: v.optional(v.number()),
      },
      returns: v.object({
        deletedCount: v.number(),
        remainingCount: v.number(),
      }),
      handler: async (ctx, args) => {
        if (opts?.evalPrune) {
          await opts.evalPrune(ctx, collection, args.documentId);
        }

        const result = await ctx.runMutation(component.public.pruneVersions, {
          collection,
          documentId: args.documentId,
          keepCount: args.keepCount ?? defaultKeepCount,
          retentionDays: args.retentionDays ?? defaultRetentionDays,
        });

        if (opts?.onPrune) {
          await opts.onPrune(ctx, result);
        }

        return result;
      },
    });
  }
}
