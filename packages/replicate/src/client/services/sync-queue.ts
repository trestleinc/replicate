/**
 * Background Sync Queue
 *
 * Provides a non-blocking task queue for sync operations with:
 * - FIFO ordering per document
 * - Exponential backoff on failure
 * - Task coalescing (new task replaces pending)
 * - Observable pending state for UI indicators
 *
 * This solves the fire-and-forget vs blocking sync dilemma:
 * - Fire-and-forget loses errors and has no retry
 * - Blocking sync freezes the UI
 * - Background queue provides both responsiveness and reliability
 */

import { getLogger } from '$/shared/logger';

const logger = getLogger(['replicate', 'sync-queue']);

/** Configuration for the sync queue */
export interface SyncQueueConfig {
	/** Maximum retry attempts per task (default: 3) */
	maxRetries?: number;
	/** Base delay for exponential backoff in ms (default: 1000) */
	baseDelayMs?: number;
	/** Maximum delay cap in ms (default: 30000) */
	maxDelayMs?: number;
	/** Maximum concurrent tasks (default: 5) */
	maxConcurrent?: number;
}

/** State of a sync task */
export type TaskState = 'pending' | 'running' | 'completed' | 'failed';

/** Internal representation of a sync task */
interface SyncTask {
	id: string;
	documentId: string;
	execute: () => Promise<void>;
	state: TaskState;
	retryCount: number;
	createdAt: number;
	lastAttemptAt?: number;
	error?: Error;
}

/** Public interface for the sync queue */
export interface SyncQueue {
	/**
	 * Enqueue a sync task. Returns immediately.
	 * If a task for the same document is already pending, it will be replaced.
	 *
	 * @param documentId - The document this sync is for
	 * @param syncFn - Async function that performs the sync
	 * @returns Task ID for tracking
	 */
	enqueue(documentId: string, syncFn: () => Promise<void>): string;

	/**
	 * Check if there are pending or running tasks for a document.
	 */
	hasPending(documentId: string): boolean;

	/**
	 * Get the current task state for a document.
	 */
	getTaskState(documentId: string): TaskState | null;

	/**
	 * Subscribe to pending state changes for a document.
	 * Callback is called with true when task starts, false when completes/fails.
	 *
	 * @returns Unsubscribe function
	 */
	onPendingChange(documentId: string, callback: (pending: boolean) => void): () => void;

	/**
	 * Subscribe to all queue state changes.
	 * Useful for global loading indicators.
	 *
	 * @returns Unsubscribe function
	 */
	onQueueChange(callback: (activeCount: number) => void): () => void;

	/**
	 * Wait for all pending tasks to complete.
	 * Useful for testing and cleanup.
	 */
	flush(): Promise<void>;

	/**
	 * Cancel all pending tasks for a document.
	 * Running tasks cannot be cancelled.
	 */
	cancel(documentId: string): void;

	/**
	 * Get queue statistics.
	 */
	getStats(): {
		pending: number;
		running: number;
		completed: number;
		failed: number;
	};

	/**
	 * Destroy the queue and cancel all tasks.
	 */
	destroy(): void;
}

/**
 * Create a new sync queue.
 */
export function createSyncQueue(config: SyncQueueConfig = {}): SyncQueue {
	const { maxRetries = 3, baseDelayMs = 1000, maxDelayMs = 30000, maxConcurrent = 5 } = config;

	let taskCounter = 0;
	let destroyed = false;

	// Tasks indexed by document ID (only one task per document)
	const tasks = new Map<string, SyncTask>();

	// Completed/failed tasks for stats (kept briefly for debugging)
	const completedTasks: SyncTask[] = [];
	const MAX_COMPLETED_HISTORY = 100;

	// Listeners
	const pendingListeners = new Map<string, Set<(pending: boolean) => void>>();
	const queueListeners = new Set<(activeCount: number) => void>();

	// Processing state
	let processingPromise: Promise<void> | null = null;
	const retryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

	function getActiveCount(): number {
		let count = 0;
		for (const task of tasks.values()) {
			if (task.state === 'pending' || task.state === 'running') {
				count++;
			}
		}
		return count;
	}

	function notifyPendingChange(documentId: string, pending: boolean): void {
		const listeners = pendingListeners.get(documentId);
		if (listeners) {
			for (const listener of listeners) {
				try {
					listener(pending);
				} catch (err) {
					logger.error('Error in pending listener', {
						documentId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}
	}

	function notifyQueueChange(): void {
		const activeCount = getActiveCount();
		for (const listener of queueListeners) {
			try {
				listener(activeCount);
			} catch (err) {
				logger.error('Error in queue listener', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	function calculateBackoff(retryCount: number): number {
		// Exponential backoff: baseDelay * 2^retryCount
		const delay = baseDelayMs * Math.pow(2, retryCount);
		// Add jitter (±20%)
		const jitter = delay * 0.2 * (Math.random() * 2 - 1);
		return Math.min(delay + jitter, maxDelayMs);
	}

	async function processTask(task: SyncTask): Promise<void> {
		if (destroyed) return;

		task.state = 'running';
		task.lastAttemptAt = Date.now();

		logger.debug('Processing sync task', {
			taskId: task.id,
			documentId: task.documentId,
			retryCount: task.retryCount,
		});

		try {
			await task.execute();

			// Success
			task.state = 'completed';
			tasks.delete(task.documentId);
			completedTasks.push(task);

			// Trim history
			while (completedTasks.length > MAX_COMPLETED_HISTORY) {
				completedTasks.shift();
			}

			logger.debug('Sync task completed', {
				taskId: task.id,
				documentId: task.documentId,
			});

			notifyPendingChange(task.documentId, false);
			notifyQueueChange();
		} catch (error) {
			task.error = error instanceof Error ? error : new Error(String(error));

			logger.error('Sync task failed', {
				taskId: task.id,
				documentId: task.documentId,
				retryCount: task.retryCount,
				error: task.error.message,
			});

			if (task.retryCount < maxRetries) {
				// Schedule retry
				task.retryCount++;
				task.state = 'pending';

				const delay = calculateBackoff(task.retryCount);
				logger.debug('Scheduling retry', {
					taskId: task.id,
					documentId: task.documentId,
					retryCount: task.retryCount,
					delayMs: delay,
				});

				const timeoutId = setTimeout(() => {
					retryTimeouts.delete(task.documentId);
					processTask(task);
				}, delay);

				retryTimeouts.set(task.documentId, timeoutId);
			} else {
				// Max retries exceeded
				task.state = 'failed';
				tasks.delete(task.documentId);
				completedTasks.push(task);

				while (completedTasks.length > MAX_COMPLETED_HISTORY) {
					completedTasks.shift();
				}

				logger.warn('Sync task failed after max retries', {
					taskId: task.id,
					documentId: task.documentId,
					maxRetries,
				});

				notifyPendingChange(task.documentId, false);
				notifyQueueChange();
			}
		}
	}

	let runningCount = 0;

	function processQueue(): void {
		if (destroyed) return;

		// Process pending tasks up to the concurrency limit.
		// This prevents overwhelming the server with too many concurrent mutations
		// (e.g. Convex disconnects with TooManyConcurrentMutations at ~50).
		for (const task of tasks.values()) {
			if (runningCount >= maxConcurrent) break;
			if (task.state === 'pending') {
				runningCount++;
				processTask(task).finally(() => {
					runningCount--;
					// Continue draining the queue after each task completes
					if (!destroyed) {
						processQueue();
					}
				});
			}
		}
	}

	return {
		enqueue(documentId: string, syncFn: () => Promise<void>): string {
			if (destroyed) {
				throw new Error('SyncQueue has been destroyed');
			}

			const existingTask = tasks.get(documentId);

			// If there's an existing pending task, replace it (coalescing)
			if (existingTask && existingTask.state === 'pending') {
				// Cancel any pending retry
				const timeoutId = retryTimeouts.get(documentId);
				if (timeoutId) {
					clearTimeout(timeoutId);
					retryTimeouts.delete(documentId);
				}

				logger.debug('Replacing pending task', {
					oldTaskId: existingTask.id,
					documentId,
				});
			}

			// If there's a running task, we still queue the new one
			// It will execute after the current one completes

			const taskId = `sync-${++taskCounter}-${Date.now()}`;
			const task: SyncTask = {
				id: taskId,
				documentId,
				execute: syncFn,
				state: 'pending',
				retryCount: 0,
				createdAt: Date.now(),
			};

			tasks.set(documentId, task);

			logger.debug('Enqueued sync task', {
				taskId,
				documentId,
				hasExisting: !!existingTask,
			});

			notifyPendingChange(documentId, true);
			notifyQueueChange();

			// Start processing on next tick
			if (!processingPromise) {
				processingPromise = Promise.resolve().then(() => {
					processingPromise = null;
					processQueue();
				});
			}

			return taskId;
		},

		hasPending(documentId: string): boolean {
			const task = tasks.get(documentId);
			return task !== undefined && (task.state === 'pending' || task.state === 'running');
		},

		getTaskState(documentId: string): TaskState | null {
			const task = tasks.get(documentId);
			return task?.state ?? null;
		},

		onPendingChange(documentId: string, callback: (pending: boolean) => void): () => void {
			let listeners = pendingListeners.get(documentId);
			if (!listeners) {
				listeners = new Set();
				pendingListeners.set(documentId, listeners);
			}
			listeners.add(callback);

			// Immediately notify current state
			const task = tasks.get(documentId);
			const isPending =
				task !== undefined && (task.state === 'pending' || task.state === 'running');
			callback(isPending);

			return () => {
				listeners?.delete(callback);
				if (listeners?.size === 0) {
					pendingListeners.delete(documentId);
				}
			};
		},

		onQueueChange(callback: (activeCount: number) => void): () => void {
			queueListeners.add(callback);

			// Immediately notify current state
			callback(getActiveCount());

			return () => {
				queueListeners.delete(callback);
			};
		},

		async flush(): Promise<void> {
			// Wait for all tasks to complete
			while (getActiveCount() > 0) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		},

		cancel(documentId: string): void {
			const task = tasks.get(documentId);
			if (task && task.state === 'pending') {
				// Cancel retry timeout
				const timeoutId = retryTimeouts.get(documentId);
				if (timeoutId) {
					clearTimeout(timeoutId);
					retryTimeouts.delete(documentId);
				}

				tasks.delete(documentId);
				notifyPendingChange(documentId, false);
				notifyQueueChange();

				logger.debug('Cancelled sync task', {
					taskId: task.id,
					documentId,
				});
			}
		},

		getStats(): { pending: number; running: number; completed: number; failed: number } {
			let pending = 0;
			let running = 0;
			let completed = 0;
			let failed = 0;

			for (const task of tasks.values()) {
				if (task.state === 'pending') pending++;
				if (task.state === 'running') running++;
			}

			for (const task of completedTasks) {
				if (task.state === 'completed') completed++;
				if (task.state === 'failed') failed++;
			}

			return { pending, running, completed, failed };
		},

		destroy(): void {
			destroyed = true;

			// Cancel all retry timeouts
			for (const timeoutId of retryTimeouts.values()) {
				clearTimeout(timeoutId);
			}
			retryTimeouts.clear();

			// Clear all tasks
			tasks.clear();
			completedTasks.length = 0;

			// Clear listeners
			pendingListeners.clear();
			queueListeners.clear();

			logger.debug('SyncQueue destroyed');
		},
	};
}
