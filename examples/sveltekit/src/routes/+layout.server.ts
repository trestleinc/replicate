import { PUBLIC_CONVEX_URL } from "$env/static/public";
import { ConvexHttpClient } from "convex/browser";
import { api } from "$convex/_generated/api";
import type { PaginatedMaterial, PaginatedPage } from "@trestleinc/replicate/client";
import type { Interval } from "$collections/useIntervals";

const httpClient = new ConvexHttpClient(PUBLIC_CONVEX_URL);

const PAGE_SIZE = 25;

export async function load() {
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
		// Log error but return empty data so the app can still render
		// The client will sync data once persistence is initialized
		console.error("Failed to load initial data from Convex:", error);

		const emptyIntervalsMaterial: PaginatedMaterial<Interval> = {
			pages: [],
			cursor: "",
			isDone: true,
		};

		return {
			intervalsMaterial: emptyIntervalsMaterial,
			commentsMaterial: [],
		};
	}
}
