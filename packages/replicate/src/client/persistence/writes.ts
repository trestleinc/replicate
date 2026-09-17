/** Serializes durable work, retaining a failed operation for an explicit flush retry. */
export class PersistenceWrites {
	private pending: (() => Promise<void>)[] = [];
	private running: Promise<void> | undefined;

	add(write: () => Promise<void>): void {
		this.pending.push(write);
		void this.flush().catch(() => {});
	}

	flush(): Promise<void> {
		if (!this.running) {
			this.running = Promise.resolve().then(async () => {
				try {
					while (this.pending.length) {
						await this.pending[0]();
						this.pending.shift();
					}
				} finally {
					// Clear before resolving the drain, so a new flush cannot reuse
					// a completed promise while newly queued writes remain pending.
					this.running = undefined;
				}
			});
		}
		return this.running;
	}
}
