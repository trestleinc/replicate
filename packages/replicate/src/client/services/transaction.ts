/**
 * Client-side Transaction Coordinator
 *
 * Inspired by:
 * - Convex OCC: Staged changes, conflict detection at commit time
 * - TanStack DB: Automatic rollback on error, isPersisted pattern
 * - Yjs: Transaction origins for selective tracking
 *
 * This coordinator provides ACID-like guarantees for client-side mutations:
 * - Atomicity: All changes in a transaction succeed or fail together
 * - Consistency: Only committed state is visible to other operations
 * - Isolation: Pending transactions don't interfere with each other
 * - Durability: Committed changes are persisted to server
 */

import { getLogger } from '$/shared/logger';

const logger = getLogger(['replicate', 'transaction']);

/** Types of changes that can be staged in a transaction */
export type ChangeType = 'insert' | 'update' | 'delete';

/** A staged change that hasn't been committed yet */
export interface StagedChange {
	type: ChangeType;
	documentId: string;
	delta?: Uint8Array;
	/** Captured state for rollback (only for updates) */
	previousState?: Uint8Array;
}

/** Transaction state machine */
export type TransactionState = 'pending' | 'committing' | 'committed' | 'rolledback' | 'failed';

/** Result of a transaction commit */
export interface CommitResult {
	success: boolean;
	error?: Error;
}

/**
 * Represents a single transaction with staged changes.
 */
export interface ClientTransaction {
	readonly id: string;
	readonly state: TransactionState;
	readonly createdAt: number;

	/**
	 * Stage an insert operation.
	 * The insert is not visible until the transaction commits.
	 */
	stageInsert(documentId: string, delta: Uint8Array): void;

	/**
	 * Stage an update operation.
	 * The update is not visible until the transaction commits.
	 */
	stageUpdate(documentId: string, delta: Uint8Array, previousState?: Uint8Array): void;

	/**
	 * Stage a delete operation.
	 * The delete is not visible until the transaction commits.
	 */
	stageDelete(documentId: string): void;

	/**
	 * Check if a document is being modified in this transaction.
	 */
	isModifying(documentId: string): boolean;

	/**
	 * Check if a document is being deleted in this transaction.
	 */
	isDeleting(documentId: string): boolean;

	/**
	 * Get all staged changes.
	 */
	getStagedChanges(): ReadonlyArray<StagedChange>;

	/**
	 * Rollback all staged changes.
	 * Called automatically on error, or can be called manually.
	 */
	rollback(): void;
}

/**
 * Callbacks for applying/reverting changes during commit/rollback.
 */
export interface TransactionCallbacks {
	/** Called for each staged change during commit */
	onApply(change: StagedChange): Promise<void>;
	/** Called for each staged change during rollback */
	onRevert(change: StagedChange): Promise<void>;
}

/**
 * Internal implementation of ClientTransaction.
 */
class TransactionImpl implements ClientTransaction {
	readonly id: string;
	readonly createdAt: number;
	private _state: TransactionState = 'pending';
	private _changes: StagedChange[] = [];
	private _appliedChanges: StagedChange[] = [];
	private _callbacks: TransactionCallbacks;

	constructor(id: string, callbacks: TransactionCallbacks) {
		this.id = id;
		this.createdAt = Date.now();
		this._callbacks = callbacks;
	}

	get state(): TransactionState {
		return this._state;
	}

	stageInsert(documentId: string, delta: Uint8Array): void {
		this.assertPending();
		this._changes.push({ type: 'insert', documentId, delta });
		logger.debug('Staged insert', { txId: this.id, documentId });
	}

	stageUpdate(documentId: string, delta: Uint8Array, previousState?: Uint8Array): void {
		this.assertPending();
		this._changes.push({ type: 'update', documentId, delta, previousState });
		logger.debug('Staged update', { txId: this.id, documentId });
	}

	stageDelete(documentId: string): void {
		this.assertPending();
		this._changes.push({ type: 'delete', documentId });
		logger.debug('Staged delete', { txId: this.id, documentId });
	}

	isModifying(documentId: string): boolean {
		return this._changes.some((c) => c.documentId === documentId);
	}

	isDeleting(documentId: string): boolean {
		return this._changes.some((c) => c.documentId === documentId && c.type === 'delete');
	}

	getStagedChanges(): ReadonlyArray<StagedChange> {
		return this._changes;
	}

	rollback(): void {
		if (this._state === 'rolledback') return;

		logger.debug('Rolling back transaction', {
			txId: this.id,
			appliedCount: this._appliedChanges.length,
		});

		this._state = 'rolledback';

		// Revert applied changes in reverse order
		for (let i = this._appliedChanges.length - 1; i >= 0; i--) {
			const change = this._appliedChanges[i];
			try {
				// Fire-and-forget revert - best effort
				this._callbacks.onRevert(change).catch((err) => {
					logger.error('Failed to revert change', {
						txId: this.id,
						documentId: change.documentId,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			} catch (err) {
				logger.error('Sync error reverting change', {
					txId: this.id,
					documentId: change.documentId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		this._appliedChanges = [];
		this._changes = [];
	}

	/**
	 * Commit all staged changes.
	 * This is called by the coordinator after server mutations succeed.
	 */
	async commit(): Promise<CommitResult> {
		this.assertPending();
		this._state = 'committing';

		logger.debug('Committing transaction', { txId: this.id, changeCount: this._changes.length });

		try {
			// Apply all changes
			for (const change of this._changes) {
				await this._callbacks.onApply(change);
				this._appliedChanges.push(change);
			}

			this._state = 'committed';
			logger.debug('Transaction committed', { txId: this.id });
			return { success: true };
		} catch (error) {
			this._state = 'failed';
			logger.error('Transaction commit failed, rolling back', {
				txId: this.id,
				error: error instanceof Error ? error.message : String(error),
			});

			// Rollback on failure
			this.rollback();

			return {
				success: false,
				error: error instanceof Error ? error : new Error(String(error)),
			};
		}
	}

	private assertPending(): void {
		if (this._state !== 'pending') {
			throw new Error(`Cannot modify transaction in state: ${this._state}`);
		}
	}
}

/**
 * Coordinates transactions across multiple documents.
 */
export interface TransactionCoordinator {
	/**
	 * Execute a function within a transaction context.
	 * All staged changes are applied atomically on success.
	 * On any error, all changes are automatically rolled back.
	 *
	 * @param serverMutation - Async function that performs server mutations.
	 *   If this throws, the transaction is rolled back.
	 * @returns The result of the serverMutation function.
	 */
	transaction<T>(serverMutation: (tx: ClientTransaction) => Promise<T>): Promise<T>;

	/**
	 * Check if any transaction is currently deleting this document.
	 * Used by subscription handlers to skip updates for documents being deleted.
	 */
	isDocumentBeingDeleted(documentId: string): boolean;

	/**
	 * Check if any transaction is currently modifying this document.
	 */
	isDocumentBeingModified(documentId: string): boolean;

	/**
	 * Get the number of active transactions.
	 */
	getActiveTransactionCount(): number;
}

/**
 * Create a transaction coordinator.
 *
 * @param callbacks - Callbacks for applying/reverting changes.
 */
export function createTransactionCoordinator(
	callbacks: TransactionCallbacks
): TransactionCoordinator {
	let txCounter = 0;
	const activeTransactions = new Map<string, TransactionImpl>();

	return {
		async transaction<T>(serverMutation: (tx: ClientTransaction) => Promise<T>): Promise<T> {
			const txId = `tx-${++txCounter}-${Date.now()}`;
			const tx = new TransactionImpl(txId, callbacks);
			activeTransactions.set(txId, tx);

			logger.debug('Starting transaction', { txId });

			try {
				// Execute the server mutation function
				// This is where the caller stages changes and calls server mutations
				const result = await serverMutation(tx);

				// If we get here, server mutations succeeded
				// Now commit local changes
				const commitResult = await tx.commit();
				if (!commitResult.success) {
					throw commitResult.error ?? new Error('Commit failed');
				}

				return result;
			} catch (error) {
				// Server mutation or commit failed - rollback
				logger.error('Transaction failed', {
					txId,
					error: error instanceof Error ? error.message : String(error),
				});

				if (tx.state === 'pending') {
					tx.rollback();
				}

				throw error;
			} finally {
				activeTransactions.delete(txId);
			}
		},

		isDocumentBeingDeleted(documentId: string): boolean {
			for (const tx of activeTransactions.values()) {
				if (tx.state === 'pending' || tx.state === 'committing') {
					if (tx.isDeleting(documentId)) {
						return true;
					}
				}
			}
			return false;
		},

		isDocumentBeingModified(documentId: string): boolean {
			for (const tx of activeTransactions.values()) {
				if (tx.state === 'pending' || tx.state === 'committing') {
					if (tx.isModifying(documentId)) {
						return true;
					}
				}
			}
			return false;
		},

		getActiveTransactionCount(): number {
			return activeTransactions.size;
		},
	};
}

export type { TransactionImpl };
