/**
 * CRDT Field Handlers
 *
 * Map-based dispatch system for CRDT field initialization.
 * No switch statements - pure functions and Map lookups.
 */

import * as Y from 'yjs';
import { assertNever, type CrdtType } from '$/shared/crdt';
import { isDoc, fragmentFromJSON } from '$/client/merge';

/**
 * Parameters for CRDT initialization functions.
 */
export type InitParams = {
	value: unknown;
	clientId: string;
	fieldsMap: Y.Map<unknown>;
	fieldName: string;
};

/**
 * Type for CRDT initialization functions.
 */
export type CrdtInitializer = (params: InitParams) => void;

/**
 * Initialize a prose field with Y.XmlFragment.
 */
const initProse: CrdtInitializer = ({ value, fieldsMap, fieldName }) => {
	if (!isDoc(value)) return;
	const fragment = new Y.XmlFragment();
	fieldsMap.set(fieldName, fragment);
	fragmentFromJSON(fragment, value);
};

/**
 * Initialize a counter field with Y.Array.
 */
const initCounter: CrdtInitializer = ({ value, clientId, fieldsMap, fieldName }) => {
	const array = new Y.Array<{ client: string; delta: number; timestamp: number }>();
	fieldsMap.set(fieldName, array);

	const initialValue = typeof value === 'number' ? value : 0;
	if (initialValue !== 0) {
		array.push([
			{
				client: clientId,
				delta: initialValue,
				timestamp: Date.now(),
			},
		]);
	}
};

/**
 * Initialize a register field with Y.Map.
 */
const initRegister: CrdtInitializer = ({ value, clientId, fieldsMap, fieldName }) => {
	const map = new Y.Map<{ value: unknown; timestamp: number }>();
	fieldsMap.set(fieldName, map);

	if (value !== undefined && value !== null) {
		map.set(clientId, { value, timestamp: Date.now() });
	}
};

/**
 * Initialize a set field with Y.Map.
 */
const initSet: CrdtInitializer = ({ value, clientId, fieldsMap, fieldName }) => {
	const map = new Y.Map<{ addedBy: string; addedAt: number }>();
	fieldsMap.set(fieldName, map);

	const values = Array.isArray(value) ? value : [];
	for (const item of values) {
		const key = JSON.stringify(item);
		map.set(key, { addedBy: clientId, addedAt: Date.now() });
	}
};

/**
 * Map-based dispatch registry.
 * No switch statements - O(1) lookup by CRDT type.
 */
const crdtInitializers = new Map<CrdtType, CrdtInitializer>([
	['prose', initProse],
	['counter', initCounter],
	['register', initRegister],
	['set', initSet],
]);

/**
 * Default values for CRDT types.
 * Used when a CRDT field is not provided during insert.
 */
const crdtDefaults = new Map<CrdtType, unknown>([
	['prose', { type: 'doc', content: [] }],
	['counter', 0],
	['register', undefined],
	['set', []],
]);

/**
 * Get default value for a CRDT type.
 * Returns undefined for register (optional by nature).
 */
export const getDefaultForCrdtType = (type: CrdtType): unknown => crdtDefaults.get(type);

/**
 * Initialize a CRDT field based on its type.
 * Uses Map lookup with exhaustiveness checking.
 */
export const initializeCrdtField = (type: CrdtType, params: InitParams): void => {
	const initializer = crdtInitializers.get(type);

	if (!initializer) {
		// This should never happen if all CRDT types are registered
		// Cast to never for exhaustive type checking
		return assertNever(type as never);
	}

	initializer(params);
};

/**
 * Type guard for Yjs CRDT values.
 * Checks if a value is a Y.Array, Y.Map, or Y.XmlFragment.
 */
export const isCrdtValue = (
	value: unknown
): value is Y.Array<unknown> | Y.Map<unknown> | Y.XmlFragment =>
	value instanceof Y.Array || value instanceof Y.Map || value instanceof Y.XmlFragment;
