import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { useLiveQuery } from '@tanstack/react-db';
import type { Materialized } from '@trestleinc/replicate/client';
import { intervals, type Interval } from '../collections/useIntervals';
import { comments, type Comment } from '../collections/useComments';

interface IntervalsContextValue {
	collection: ReturnType<typeof intervals.get>;
	intervals: Interval[];
	isLoading: boolean;
}

const IntervalsContext = createContext<IntervalsContextValue | null>(null);

let persistenceInitialized = false;

interface PersistenceGateProps {
	children: ReactNode;
	intervalsMaterial?: Materialized<Interval>;
	commentsMaterial?: Materialized<Comment>;
}

function PersistenceGate({ children, intervalsMaterial, commentsMaterial }: PersistenceGateProps) {
	const [ready, setReady] = useState(persistenceInitialized);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!ready) {
			Promise.all([
				intervals.init(intervalsMaterial ?? undefined),
				comments.init(commentsMaterial ?? undefined),
			])
				.then(() => {
					persistenceInitialized = true;
					setReady(true);
				})
				.catch((err) => {
					console.error('PersistenceGate init failed:', err);
					setError(err instanceof Error ? err.message : String(err));
				});
		}
	}, [ready, intervalsMaterial, commentsMaterial]);

	if (error) {
		return (
			<div className="flex h-screen items-center justify-center">
				<div className="max-w-md px-4 text-center">
					<p className="text-destructive mb-4">{error}</p>
					<button
						type="button"
						className="border-muted rounded border px-4 py-2 text-sm"
						onClick={() => location.reload()}
					>
						Retry
					</button>
				</div>
			</div>
		);
	}

	if (!ready) {
		return (
			<div className="flex h-screen items-center justify-center">
				<div className="text-muted-foreground">Loading...</div>
			</div>
		);
	}

	return <>{children}</>;
}

function IntervalsProviderInner({ children }: { children: ReactNode }) {
	const collection = intervals.get();
	const { data: intervalsData = [], isLoading } = useLiveQuery(collection);

	return (
		<IntervalsContext.Provider
			value={{
				collection,
				intervals: intervalsData,
				isLoading,
			}}
		>
			{children}
		</IntervalsContext.Provider>
	);
}

interface IntervalsProviderProps {
	children: ReactNode;
	intervalsMaterial?: Materialized<Interval>;
	commentsMaterial?: Materialized<Comment>;
}

export function IntervalsProvider({
	children,
	intervalsMaterial,
	commentsMaterial,
}: IntervalsProviderProps) {
	return (
		<PersistenceGate intervalsMaterial={intervalsMaterial} commentsMaterial={commentsMaterial}>
			<IntervalsProviderInner>{children}</IntervalsProviderInner>
		</PersistenceGate>
	);
}

export function useIntervalsContext() {
	const ctx = useContext(IntervalsContext);
	if (!ctx) {
		throw new Error('useIntervalsContext must be used within IntervalsProvider');
	}
	return ctx;
}
