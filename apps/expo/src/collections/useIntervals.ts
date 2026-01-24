import { collection, persistence } from '@trestleinc/replicate/client';
import { ConvexClient } from 'convex/browser';
import { open } from '@op-engineering/op-sqlite';
import { api } from '$convex/_generated/api';
import { intervalSchema } from '$convex/schema/intervals';

const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL!;

export const intervals = collection.create({
  schema: intervalSchema,
  persistence: async () => {
    const db = open({ name: 'intervals.db' });
    return persistence.native.sqlite.create(db, 'intervals');
  },
  config: () => ({
    convexClient: new ConvexClient(CONVEX_URL),
    api: api.intervals,
    getKey: (interval: Interval) => interval.id,
  }),
});

export type Interval = NonNullable<typeof intervals.$docType>;
