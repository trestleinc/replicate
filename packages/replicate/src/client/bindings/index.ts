/**
 * CRDT Bindings Barrel Export
 *
 * Export all CRDT binding types and functions.
 */

// Shared sync registry
export { getSyncManager, cleanupSyncManager, hasSyncManager } from './sync-registry';

// Counter
export {
	type CounterBinding,
	type CounterBindingConfig,
	type CounterDelta,
	createCounterBinding,
	cleanup as cleanupCounterBindings,
} from './counter';

// Register
export {
	type RegisterBinding,
	type RegisterBindingConfig,
	type RegisterEntry,
	createRegisterBinding,
	cleanup as cleanupRegisterBindings,
} from './register';

// Set
export {
	type SetBinding,
	type SetBindingConfig,
	type SetEntry,
	createSetBinding,
	cleanup as cleanupSetBindings,
} from './set';
