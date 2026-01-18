export interface InfiniteScrollOptions {
	onLoadMore: () => Promise<void>;
	hasMore: boolean;
	rootMargin?: string;
	threshold?: number;
}

export function infiniteScroll(node: HTMLElement, options: InfiniteScrollOptions) {
	let observer: IntersectionObserver | null = null;
	let loading = false;

	function setup(opts: InfiniteScrollOptions) {
		observer?.disconnect();

		if (!opts.hasMore) return;

		observer = new IntersectionObserver(
			async entries => {
				const entry = entries[0];
				if (entry?.isIntersecting && opts.hasMore && !loading) {
					loading = true;
					try {
						await opts.onLoadMore();
					} finally {
						loading = false;
					}
				}
			},
			{
				root: null,
				rootMargin: opts.rootMargin ?? "200px",
				threshold: opts.threshold ?? 0,
			},
		);

		observer.observe(node);
	}

	setup(options);

	return {
		update(newOptions: InfiniteScrollOptions) {
			setup(newOptions);
		},
		destroy() {
			observer?.disconnect();
		},
	};
}
