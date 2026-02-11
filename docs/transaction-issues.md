# Transaction Architecture Issues in Replicate Client

> **Document Purpose**: This document serves as both technical documentation and research material for pattern discovery in distributed client-server synchronization systems.

## Abstract

The replicate client package experienced a series of "fix" commits that attempted to resolve race conditions and data consistency issues. These fixes failed because they applied band-aid solutions to a fundamentally non-transactional architecture. This document analyzes the root causes, catalogs the anti-patterns discovered, and proposes a transaction-based solution inspired by Convex's Optimistic Concurrency Control (OCC) model and TanStack DB's automatic rollback pattern.

---

## 1. Problem Statement

### 1.1 System Overview

Replicate is a client-side synchronization library that bridges:

- **Yjs CRDTs**: For conflict-free collaborative editing
- **TanStack DB**: For reactive client-side state management
- **Convex**: For server-side persistence and real-time subscriptions

### 1.2 Core Issue

The client performs multi-step mutations (delete, update, sync) without ACID guarantees, leading to:

| Symptom                | User-Visible Behavior                         |
| ---------------------- | --------------------------------------------- |
| Race conditions        | Items reappear after deletion ("ghost items") |
| Streaming blocks       | UI freezes during network operations          |
| State divergence       | Yjs and TanStack DB show different data       |
| Subscription conflicts | Server updates overwrite local changes        |

### 1.3 Stable vs Broken Commits

| Commit    | Status     | Description                                |
| --------- | ---------- | ------------------------------------------ |
| `704d011` | **STABLE** | Last known working state                   |
| `a8fd52c` | BROKEN     | "fix: improve sync reliability"            |
| `eeb0bc6` | BROKEN     | "fix: resolve 12 critical race conditions" |
| `c33249a` | BROKEN     | "fix: prevent document resurrection"       |

---

## 2. Anti-Pattern Analysis

### 2.1 Anti-Pattern: Dual State Mechanisms

**Definition**: Using multiple independent mechanisms to track the same state, creating synchronization windows where they can diverge.

**Evidence in Codebase** (documents.ts):

```typescript
// Mechanism 1: In-memory Set (transient)
const deletedIds = new Set<string>();

// Mechanism 2: Yjs document flag (persisted)
doc.getMap('_meta').set('_deleted', true);
```

**Failure Mode**:

```
Timeline:
1. User clicks delete
2. deletedIds.add('doc-1')           // Mechanism 1: marked
3. Server mutation starts...
4. Server mutation FAILS
5. deletedIds.delete('doc-1')        // Mechanism 1: cleared
6. BUT: _meta._deleted may already be set by previous delta
7. STATE DIVERGENCE: deletedIds says "not deleted", _meta says "deleted"
```

**Hypothesis**: Any system using N independent mechanisms to track state S will have N-1 potential divergence points.

**Recommendation**: Single source of truth. Use only Yjs document state.

---

### 2.2 Anti-Pattern: Optimistic Mutations Without Transactional Rollback

**Definition**: Applying local changes before server confirmation without a proper rollback mechanism that can atomically revert all changes on failure.

**Evidence in Codebase** (collection.ts:751-793):

```typescript
onDelete: async ({ transaction }) => {
  // Phase 1: Mark ALL documents as deleted BEFORE any server calls
  for (const mut of mutations) {
    docManager.markDeleted(String(mut.key));  // LOCAL STATE CHANGED
  }

  // Phase 2: Server calls (can fail!)
  const results = await Promise.allSettled(
    mutations.map(async (mut) => {
      await convexClient.mutation(api.replicate, { ... });
    })
  );

  // Phase 3: Manual "rollback" for failures
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      docManager.clearDeleted(docId);  // MANUAL ROLLBACK - can race!
    }
  });
}
```

**Failure Mode**:

```
Timeline:
1. markDeleted('doc-1')              // State: deleted
2. Server mutation starts...
3. Subscription update arrives for 'doc-1'
4. applyUpdate() checks deletedIds → skips update (CORRECT)
5. Server mutation FAILS
6. clearDeleted('doc-1')             // State: not deleted
7. BUT: We already skipped the subscription update!
8. RESULT: doc-1 is now stale/missing data
```

**Comparison with TanStack DB**:

```typescript
// TanStack DB approach - automatic rollback
const tx = createTransaction({
  mutationFn: async () => {
    // If this throws, ALL staged changes are rolled back
    await fetch('/api/delete', { ... });
  }
});

tx.mutate(() => {
  collection.delete("doc-1");  // Staged, not applied
});

await tx.commit();  // Only now applied, or rolled back on error
```

**Hypothesis**: Optimistic updates require transactional boundaries with automatic rollback to maintain consistency.

---

### 2.3 Anti-Pattern: Fire-and-Forget vs Blocking (False Dichotomy)

**Definition**: Treating "fire-and-forget" (loses errors) and "blocking sync" (poor UX) as the only two options, when background task queues solve both problems.

**Evidence in Codebase**:

Commit `ef4e541` introduced fire-and-forget:

```typescript
// Fire-and-forget: errors lost, no retry
syncFn().catch(console.error);
```

Commit `a8fd52c` reverted to blocking:

```typescript
// Blocking: UI freezes on network latency
await syncFn();
```

**Both approaches fail**:

| Approach        | Problem                                          |
| --------------- | ------------------------------------------------ |
| Fire-and-forget | Errors silently lost, no retry, data can be lost |
| Blocking        | UI freezes, poor UX, cascading delays            |

**Solution: Background Task Queue**:

```typescript
// Enqueue returns immediately
syncQueue.enqueue('doc-1', syncFn);

// Queue processes in background with retry
// - FIFO order per document
// - Exponential backoff on failure
// - Coalescing: new task replaces pending
// - Observable pending state for UI indicators
```

**Hypothesis**: Network operations should never block UI threads. Background queues with proper retry semantics provide both responsiveness and reliability.

---

### 2.4 Anti-Pattern: Mutex-Based Serialization with Error Swallowing

**Definition**: Using a promise chain as a mutex to serialize async operations, combined with `.catch(() => {})` that swallows errors.

**Evidence in Codebase** (collection.ts:856):

```typescript
let subscriptionMutex: Promise<void> = Promise.resolve();

const handleSubscriptionUpdate = (response: StreamResult): void => {
	subscriptionMutex = subscriptionMutex
		.catch(() => {}) // SWALLOWS ALL ERRORS
		.then(() => processSubscriptionUpdate(response));
};
```

**Problems**:

1. **Error swallowing**: Failures in `processSubscriptionUpdate` are silently ignored
2. **Head-of-line blocking**: One slow update blocks all subsequent updates
3. **No backpressure**: Queue grows unbounded during network issues
4. **Debugging nightmare**: No visibility into failures

**Hypothesis**: Mutexes are inappropriate for async event streams. Use proper queuing with error handling and backpressure.

---

## 3. Comparison with Production Systems

### 3.1 Convex OCC Model

Convex uses Optimistic Concurrency Control for server-side transactions:

```typescript
// Convex mutation - automatic OCC
export const transfer = mutation({
	handler: async (ctx, { from, to, amount }) => {
		const fromAccount = await ctx.db.get(from); // Read: version v1
		const toAccount = await ctx.db.get(to); // Read: version v2

		await ctx.db.patch(from, { balance: fromAccount.balance - amount });
		await ctx.db.patch(to, { balance: toAccount.balance + amount });

		// At commit: IF from.version != v1 OR to.version != v2 → RETRY
	},
});
```

**Key Properties**:

- Read set tracking (versions of all read documents)
- Conflict detection at commit time
- Automatic retry with exponential backoff
- Sub-transactions with `ctx.runMutation()` for partial rollback

### 3.2 TanStack DB Transaction Model

```typescript
const tx = createTransaction({
	mutationFn: async ({ transaction }) => {
		const response = await fetch('/api/update', {
			body: JSON.stringify(transaction.mutations),
		});
		if (!response.ok) throw new Error('Failed');
	},
});

tx.mutate(() => {
	collection.update('item-1', (draft) => {
		draft.value = 'new';
	});
});

try {
	await tx.commit();
} catch (error) {
	// Transaction automatically rolled back
	console.log(tx.state); // "failed"
}
```

**Key Properties**:

- Staged changes (not applied until commit)
- Automatic rollback on any error
- `isPersisted.promise` for completion tracking
- Conflict cascade: rolling back tx1 also rolls back conflicting tx2

### 3.3 Yjs Transaction Model

```typescript
// Yjs transactions bundle changes atomically
doc.transact(() => {
	ymap.set('a', 1);
	ymap.set('b', 2);
}, 'user-input'); // Origin for selective tracking

// UndoManager respects transaction boundaries
const undoManager = new Y.UndoManager(ymap, {
	trackedOrigins: new Set(['user-input']),
});
undoManager.undo(); // Undoes both 'a' and 'b' atomically
```

**Key Properties**:

- Atomic change bundling
- Transaction origins for selective tracking
- Built-in undo/redo with UndoManager
- Observers fire once per transaction, not per change

### 3.4 Current Replicate Model (Broken)

| Property               | Convex     | TanStack DB | Yjs        | Replicate          |
| ---------------------- | ---------- | ----------- | ---------- | ------------------ |
| Transaction boundaries | Yes        | Yes         | Yes        | **No**             |
| Automatic rollback     | Yes        | Yes         | Yes (undo) | **No**             |
| Conflict detection     | Yes (OCC)  | Yes         | Yes (CRDT) | **No**             |
| Error handling         | Retry      | Rollback    | N/A        | **Swallowed**      |
| State consistency      | Guaranteed | Guaranteed  | Guaranteed | **Not guaranteed** |

---

## 4. Root Cause Analysis

### 4.1 Commit Analysis

| Commit    | Intent                                         | Actual Outcome                         | Root Cause                                 |
| --------- | ---------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| `a8fd52c` | Cancel debounce timer on server update         | Lost local changes that weren't synced | Assumed server has all local state (false) |
| `eeb0bc6` | Fix 12 race conditions with multi-phase delete | Created new races between phases       | No transactional boundaries                |
| `c33249a` | Prevent resurrection with deletedIds Set       | Dual state mechanisms can diverge      | Band-aid on non-atomic architecture        |

### 4.2 Fundamental Architecture Problem

The client architecture assumes operations can be performed as independent steps:

```
Current (Broken):
┌─────────────────────────────────────────────────────────┐
│ Step 1: Mark deleted locally                            │ ← Can be observed
│ Step 2: Send to server (async, can fail)                │ ← Race window
│ Step 3: Apply Yjs delta                                 │ ← Orphaned if 2 fails
│ Step 4: Remove from TanStack                            │ ← Orphaned if 3 fails
│ Step 5: Cleanup handles                                 │ ← Orphaned if 4 fails
└─────────────────────────────────────────────────────────┘
         ↑ Each step visible to other operations ↑
```

Required (Transactional):

```
Required (Transactional):
┌─────────────────────────────────────────────────────────┐
│ Transaction {                                           │
│   Stage: mark deleted                                   │ ← Not visible
│   Stage: Yjs delta                                      │ ← Not visible
│   Stage: TanStack remove                                │ ← Not visible
│   Commit: Send to server                                │
│   On success: Apply all staged changes atomically       │
│   On failure: Discard all staged changes                │
│ }                                                       │
└─────────────────────────────────────────────────────────┘
         ↑ Only committed state visible ↑
```

---

## 5. Proposed Solution

### 5.1 Transaction Coordinator

```typescript
interface ClientTransaction {
	readonly id: string;
	readonly state: 'pending' | 'committing' | 'committed' | 'rolledback';

	// Stage changes (not applied until commit)
	stageInsert(documentId: string, delta: Uint8Array): void;
	stageUpdate(documentId: string, delta: Uint8Array): void;
	stageDelete(documentId: string): void;

	// Check if document is being modified in any pending transaction
	isBeingModified(documentId: string): boolean;

	// Commit or rollback
	commit(): Promise<void>;
	rollback(): void;
}

interface TransactionCoordinator {
	transaction<T>(fn: (tx: ClientTransaction) => Promise<T>): Promise<T>;
	isDocumentBeingDeleted(documentId: string): boolean;
}
```

### 5.2 Refactored Delete Flow

```typescript
onDelete: async ({ transaction }) => {
	await coordinator.transaction(async (tx) => {
		// Stage all deletes (not visible to other operations)
		for (const mut of transaction.mutations) {
			tx.stageDelete(String(mut.key));
		}

		// Server calls inside transaction
		await Promise.all(
			transaction.mutations.map((mut) =>
				convexClient.mutation(api.replicate, {
					document: String(mut.key),
					type: 'delete',
				})
			)
		);

		// Implicit commit on success - all changes applied atomically
	});
	// On error: automatic rollback, nothing changed
};
```

### 5.3 Background Sync Queue

```typescript
interface SyncQueue {
	enqueue(documentId: string, syncFn: () => Promise<void>): void;
	hasPending(documentId: string): boolean;
	onPendingChange(documentId: string, cb: (pending: boolean) => void): () => void;
	flush(): Promise<void>;
}
```

---

## 6. Testing Strategy

### 6.1 Checkpoints for UI Testing

Each implementation phase should be testable in the SvelteKit example app:

| Checkpoint             | Test Scenario                      | Expected Behavior                      |
| ---------------------- | ---------------------------------- | -------------------------------------- |
| CP1: Basic delete      | Delete single item                 | Item disappears, stays gone on refresh |
| CP2: Failed delete     | Delete with network error          | Item stays, error shown, retry works   |
| CP3: Concurrent delete | Delete while subscription updating | No resurrection                        |
| CP4: Batch delete      | Delete multiple items              | All or nothing semantics               |
| CP5: Streaming         | Edit prose field                   | Changes sync without UI freeze         |

### 6.2 Why Previous Tests Failed

The adversarial tests in `src/test/adversarial/` all passed but didn't catch real bugs because:

1. **Isolation**: Tested `DocumentManager` in isolation, not full collection flow
2. **Mocking**: Mocked server calls, missing actual race conditions
3. **Timing**: Used fake timers, missing real async interleaving
4. **Environment**: Node.js tests miss browser-specific issues (IndexedDB, service workers)

**Recommendation**: Integration tests in browser environment with real Convex backend.

---

## 7. References

### 7.1 External Documentation

- [Convex OCC Documentation](https://docs.convex.dev/database/advanced/occ)
- [TanStack DB Transactions](https://tanstack.com/db/latest/docs/guides/error-handling)
- [Yjs Transactions](https://docs.yjs.dev/api/shared-types#nested-transactions)

### 7.2 Related Commits

- `704d011` - Last stable commit
- `a8fd52c` - Sync reliability fix (broke streaming)
- `eeb0bc6` - Race condition fixes (broke deletion)
- `c33249a` - Resurrection fix (added dual state)

### 7.3 Implementation Branch

- Branch: `fix/transaction-model`
- Base: `704d011`

---

## Appendix A: Glossary

| Term                 | Definition                                       |
| -------------------- | ------------------------------------------------ |
| ACID                 | Atomicity, Consistency, Isolation, Durability    |
| CRDT                 | Conflict-free Replicated Data Type               |
| OCC                  | Optimistic Concurrency Control                   |
| Resurrection         | Deleted item reappearing due to race condition   |
| Staged change        | Change recorded but not yet applied              |
| Transaction boundary | Point at which all staged changes become visible |

## Appendix B: Metrics for Success

| Metric                   | Current                  | Target                    |
| ------------------------ | ------------------------ | ------------------------- |
| Delete success rate      | ~70% (resurrection bugs) | 100%                      |
| Streaming responsiveness | Blocks on network        | No blocking               |
| Error visibility         | Swallowed                | All errors logged/handled |
| State consistency        | Can diverge              | Always consistent         |
