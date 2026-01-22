import { getContext, setContext } from 'svelte';
import type { Interval, intervals as intervalsCollection } from '$collections/useIntervals';

const INTERVALS_CONTEXT_KEY = 'intervals-data';

/** The collection type returned by intervals.get() */
type IntervalsCollection = ReturnType<typeof intervalsCollection.get>;

export interface IntervalsContextValue {
	/** Reactive getter for intervals data */
	readonly data: Interval[];
	/** Reactive getter for loading state */
	readonly isLoading: boolean;
	/** The collection instance for mutations */
	readonly collection: IntervalsCollection;
}

export function setIntervalsContext(value: IntervalsContextValue) {
	setContext(INTERVALS_CONTEXT_KEY, value);
}

export function getIntervalsContext(): IntervalsContextValue {
	const ctx = getContext<IntervalsContextValue>(INTERVALS_CONTEXT_KEY);
	if (!ctx) {
		throw new Error('IntervalsContext not found. Make sure to wrap your component in a provider.');
	}
	return ctx;
}

/**
 * Try to get intervals context, returns null if not available.
 * Useful for components that can work with or without context.
 */
export function tryGetIntervalsContext(): IntervalsContextValue | null {
	try {
		return getContext<IntervalsContextValue>(INTERVALS_CONTEXT_KEY) ?? null;
	} catch {
		return null;
	}
}
