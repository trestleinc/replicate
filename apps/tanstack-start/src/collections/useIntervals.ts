import { collection } from '@trestleinc/replicate/client';
import { api } from '$convex/_generated/api';
import { intervalSchema } from '$convex/schema/intervals';
import { sqlite } from '../lib/sqlite';
import { getConvexClient } from '../lib/convex';
import type { Infer } from 'convex/values';

export const intervals = collection.create({
	schema: intervalSchema,
	persistence: sqlite,
	config: () => ({
		convexClient: getConvexClient(),
		api: api.intervals,
		getKey: (interval: Interval) => interval.id,
	}),
});

export type Interval = Infer<typeof intervalSchema.shape>;
