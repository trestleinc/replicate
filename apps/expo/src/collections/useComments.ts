import { collection, persistence } from '@trestleinc/replicate/client';
import { ConvexClient } from 'convex/browser';
import { open } from '@op-engineering/op-sqlite';
import { api } from '$convex/_generated/api';
import { commentSchema } from '$convex/schema/comments';

const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL!;

export const comments = collection.create({
  schema: commentSchema,
  persistence: async () => {
    const db = open({ name: 'comments.db' });
    return persistence.native.sqlite.create(db, 'comments');
  },
  config: () => ({
    convexClient: new ConvexClient(CONVEX_URL),
    api: api.comments,
    getKey: (comment: Comment) => comment.id,
  }),
});

export type Comment = NonNullable<typeof comments.$docType>;
