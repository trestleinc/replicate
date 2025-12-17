import { v } from 'convex/values';
import type { GenericMutationCtx, GenericQueryCtx, GenericDataModel } from 'convex/server';
import { queryGeneric, mutationGeneric } from 'convex/server';

export class Replicate<T extends object> {
  constructor(
    public component: any,
    public collectionName: string,
    private options?: { threshold?: number }
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
    const threshold = this.options?.threshold;

    return mutationGeneric({
      args: {
        documentId: v.string(),
        crdtBytes: v.bytes(),
        materializedDoc: v.any(),
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

        const version = Date.now();
        await ctx.runMutation(component.public.insertDocument, {
          collection,
          documentId: args.documentId,
          crdtBytes: args.crdtBytes,
          version,
          threshold,
        });

        await ctx.db.insert(collection, {
          id: args.documentId,
          ...(args.materializedDoc as object),
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
    const threshold = this.options?.threshold;

    return mutationGeneric({
      args: {
        documentId: v.string(),
        crdtBytes: v.bytes(),
        materializedDoc: v.any(),
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

        const version = Date.now();
        await ctx.runMutation(component.public.updateDocument, {
          collection,
          documentId: args.documentId,
          crdtBytes: args.crdtBytes,
          version,
          threshold,
        });

        const existing = await ctx.db
          .query(collection)
          .withIndex('by_doc_id', (q) => q.eq('id', args.documentId))
          .first();

        if (existing) {
          await ctx.db.patch(collection, existing._id, {
            ...(args.materializedDoc as object),
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
    const threshold = this.options?.threshold;

    return mutationGeneric({
      args: {
        documentId: v.string(),
        crdtBytes: v.bytes(),
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

        const version = Date.now();
        await ctx.runMutation(component.public.deleteDocument, {
          collection,
          documentId: documentId,
          crdtBytes: args.crdtBytes,
          version,
          threshold,
        });

        const existing = await ctx.db
          .query(collection)
          .withIndex('by_doc_id', (q) => q.eq('id', documentId))
          .first();

        if (existing) {
          await ctx.db.delete(collection, existing._id);
        }

        if (opts?.onRemove) {
          await opts.onRemove(ctx, documentId);
        }

        return {
          success: true,
          metadata: {
            documentId: documentId,
            timestamp: Date.now(),
            collection,
          },
        };
      },
    });
  }

  createRecoveryQuery(opts?: {
    evalRead?: (ctx: GenericQueryCtx<GenericDataModel>, collection: string) => void | Promise<void>;
  }) {
    const component = this.component;
    const collection = this.collectionName;

    return queryGeneric({
      args: {
        clientStateVector: v.bytes(),
      },
      returns: v.object({
        diff: v.optional(v.bytes()),
        serverStateVector: v.bytes(),
      }),
      handler: async (ctx, args) => {
        if (opts?.evalRead) {
          await opts.evalRead(ctx, collection);
        }

        return await ctx.runQuery(component.public.recovery, {
          collection,
          clientStateVector: args.clientStateVector,
        });
      },
    });
  }
}
