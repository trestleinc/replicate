import { createFileRoute, ClientOnly } from '@tanstack/react-router';
import { useIntervalsContext } from '../../contexts/IntervalsContext';
import { IntervalDetail } from '../../components/IntervalDetail';
import { IntervalEditorSkeleton } from '../../components/IntervalEditorSkeleton';

export const Route = createFileRoute('/intervals/$intervalId')({
	component: IntervalPageComponent,
});

function IntervalPageComponent() {
	const { intervalId } = Route.useParams();

	return (
		<ClientOnly fallback={<IntervalEditorSkeleton />}>
			<LiveIntervalView intervalId={intervalId} />
		</ClientOnly>
	);
}

function LiveIntervalView({ intervalId }: { intervalId: string }) {
	const { collection, intervals, isLoading } = useIntervalsContext();
	const interval = intervals.find((i) => i.id === intervalId);

	if (isLoading) {
		return <IntervalEditorSkeleton />;
	}

	if (!interval) {
		return <IntervalNotFound />;
	}

	return <IntervalDetail intervalId={intervalId} collection={collection} interval={interval} />;
}

function IntervalNotFound() {
	return (
		<div className="error-state">
			<div className="error-state-content">
				<div className="error-state-icon">
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-labelledby="error-icon-title"
						role="img"
					>
						<title id="error-icon-title">Error icon</title>
						<circle cx="12" cy="12" r="10" />
						<line x1="12" y1="8" x2="12" y2="12" />
						<line x1="12" y1="16" x2="12.01" y2="16" />
					</svg>
				</div>
				<h2>Interval not found</h2>
				<p>This interval doesn&apos;t exist or was deleted.</p>
				<a href="/intervals" className="error-state-link">
					Go back to intervals
				</a>
			</div>
		</div>
	);
}
