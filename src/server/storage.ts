import { v } from "convex/values";
import type { GenericMutationCtx, GenericQueryCtx, GenericDataModel } from "convex/server";
import { queryGeneric, mutationGeneric } from "convex/server";

export class Replicate<T extends object> {
  constructor(
    public component: any,
    public collectionName: string,
  ) {}

  createStreamQuery(opts?: {
    evalRead?: (ctx: GenericQueryCtx<GenericDataModel>, collection: string) => void | Promise<void>;
    onStream?: (ctx: GenericQueryCtx<GenericDataModel>, result: any) => void | Promise<void>;
  }) {
    const component = this.component;
    const collection = this.collectionName;

    return queryGeneric({
      args: {
        cursor: v.number(),
        limit: v.optional(v.number()),
        sizeThreshold: v.optional(v.number()),
      },
      returns: v.object({
        changes: v.array(
          v.object({
            documentId: v.string(),
            crdtBytes: v.bytes(),
            seq: v.number(),
            operationType: v.string(),
          }),
        ),
        cursor: v.number(),
        hasMore: v.boolean(),
        compact: v.optional(v.string()),
      }),
      handler: async (ctx, args) => {
        if (opts?.evalRead) {
          await opts.evalRead(ctx, collection);
        }
        const result = await ctx.runQuery(component.public.stream, {
          collection,
          cursor: args.cursor,
          limit: args.limit,
          sizeThreshold: args.sizeThreshold,
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
        cursor: v.optional(v.number()),
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

        const response: {
          documents: T[];
          cursor?: number;
          count: number;
          crdtBytes?: ArrayBuffer;
        } = {
          documents: docs,
          count: docs.length,
        };

        if (opts?.includeCRDTState) {
          const crdtState = await ctx.runQuery(component.public.getInitialState, {
            collection,
          });

          if (crdtState) {
            response.crdtBytes = crdtState.crdtBytes;
            response.cursor = crdtState.cursor;
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
      },
      returns: v.object({
        success: v.boolean(),
        seq: v.number(),
      }),
      handler: async (ctx, args) => {
        const doc = args.materializedDoc as T;

        if (opts?.evalWrite) {
          await opts.evalWrite(ctx, doc);
        }

        const result = await ctx.runMutation(component.public.insertDocument, {
          collection,
          documentId: args.documentId,
          crdtBytes: args.crdtBytes,
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
          seq: result.seq,
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
      },
      returns: v.object({
        success: v.boolean(),
        seq: v.number(),
      }),
      handler: async (ctx, args) => {
        const doc = args.materializedDoc as T;

        if (opts?.evalWrite) {
          await opts.evalWrite(ctx, doc);
        }

        const result = await ctx.runMutation(component.public.updateDocument, {
          collection,
          documentId: args.documentId,
          crdtBytes: args.crdtBytes,
        });

        const existing = await ctx.db
          .query(collection)
          .withIndex("by_doc_id", q => q.eq("id", args.documentId))
          .first();

        if (existing) {
          await ctx.db.patch(existing._id, {
            ...(args.materializedDoc as object),
            timestamp: Date.now(),
          });
        }

        if (opts?.onUpdate) {
          await opts.onUpdate(ctx, doc);
        }

        return {
          success: true,
          seq: result.seq,
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
      },
      returns: v.object({
        success: v.boolean(),
        seq: v.number(),
      }),
      handler: async (ctx, args) => {
        const documentId = args.documentId;
        if (opts?.evalRemove) {
          await opts.evalRemove(ctx, documentId);
        }

        const result = await ctx.runMutation(component.public.deleteDocument, {
          collection,
          documentId: documentId,
          crdtBytes: args.crdtBytes,
        });

        const existing = await ctx.db
          .query(collection)
          .withIndex("by_doc_id", q => q.eq("id", documentId))
          .first();

        if (existing) {
          await ctx.db.delete(existing._id);
        }

        if (opts?.onRemove) {
          await opts.onRemove(ctx, documentId);
        }

        return {
          success: true,
          seq: result.seq,
        };
      },
    });
  }

  createAckMutation(opts?: {
    evalWrite?: (ctx: GenericMutationCtx<GenericDataModel>, peerId: string) => void | Promise<void>;
  }) {
    const component = this.component;
    const collection = this.collectionName;

    return mutationGeneric({
      args: {
        peerId: v.string(),
        syncedSeq: v.number(),
      },
      returns: v.null(),
      handler: async (ctx, args) => {
        if (opts?.evalWrite) {
          await opts.evalWrite(ctx, args.peerId);
        }

        await ctx.runMutation(component.public.ack, {
          collection,
          peerId: args.peerId,
          syncedSeq: args.syncedSeq,
        });

        return null;
      },
    });
  }

  createCompactMutation(opts?: {
    evalWrite?: (ctx: GenericMutationCtx<GenericDataModel>, documentId: string) => void | Promise<void>;
  }) {
    const component = this.component;
    const collection = this.collectionName;

    return mutationGeneric({
      args: {
        documentId: v.string(),
        snapshotBytes: v.bytes(),
        stateVector: v.bytes(),
        peerTimeout: v.optional(v.number()),
      },
      returns: v.object({
        success: v.boolean(),
        removed: v.number(),
        retained: v.number(),
      }),
      handler: async (ctx, args) => {
        if (opts?.evalWrite) {
          await opts.evalWrite(ctx, args.documentId);
        }

        return await ctx.runMutation(component.public.compact, {
          collection,
          documentId: args.documentId,
          snapshotBytes: args.snapshotBytes,
          stateVector: args.stateVector,
          peerTimeout: args.peerTimeout,
        });
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
        cursor: v.number(),
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
