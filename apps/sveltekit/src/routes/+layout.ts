import { PUBLIC_CONVEX_URL } from '$env/static/public';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '$convex/_generated/api';
import { browser } from '$app/environment';
import type { PaginatedMaterial, PaginatedPage } from '@trestleinc/replicate/client';
import type { Interval } from '$collections/useIntervals';

const PAGE_SIZE = 25;

function emptyMaterial(): PaginatedMaterial<Interval> {
	return { pages: [], cursor: '', isDone: true };
}

export async function load() {
	// Client-side: never block navigation — local SQLite has the data
	if (browser) {
		return {
			intervalsMaterial: emptyMaterial(),
			commentsMaterial: [],
		};
	}

	// Server-side (SSR): attempt to seed with server data for first paint
	const httpClient = new ConvexHttpClient(PUBLIC_CONVEX_URL);
	try {
		const [intervalsPage1, commentsMaterial] = await Promise.all([
			httpClient.query(api.intervals.material as any, { numItems: PAGE_SIZE }) as Promise<
				PaginatedPage<Interval>
			>,
			httpClient.query(api.comments.material as any, {}),
		]);

		const intervalsMaterial: PaginatedMaterial<Interval> = {
			pages: [intervalsPage1],
			cursor: intervalsPage1.continueCursor,
			isDone: intervalsPage1.isDone,
		};

		return { intervalsMaterial, commentsMaterial };
	} catch (error) {
		console.error('Failed to load initial data from Convex:', error);
		return {
			intervalsMaterial: emptyMaterial(),
			commentsMaterial: [],
		};
	}
}
