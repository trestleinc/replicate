import type { GenericValidator } from 'convex/values';
import {
	isCrdtValidator,
	getCrdtType,
	CRDT_MARKER,
	type CrdtType,
	type CrdtFieldInfo,
	type CrdtValidator,
} from '$/shared/crdt';

type FieldExtractor = (v: CrdtValidator) => Partial<CrdtFieldInfo>;

const fieldExtractors = new Map<CrdtType, FieldExtractor>([
	['register', (v) => ({ resolve: v[CRDT_MARKER].resolve })],
	['prose', () => ({})],
	['counter', () => ({})],
	['set', () => ({})],
]);

interface ValidatorShape {
	kind: string;
	fields?: Record<string, ValidatorShape>;
}

/**
 * Find all CRDT fields in a validator using the CRDT marker system.
 *
 * Uses functional pipeline: filter -> map
 */
export function findCrdtFields(validator: GenericValidator): CrdtFieldInfo[] {
	const v = validator as unknown as ValidatorShape;
	if (v.kind !== 'object' || !v.fields) return [];

	return Object.entries(v.fields)
		.filter(([, fieldValidator]) => isCrdtValidator(fieldValidator as unknown as GenericValidator))
		.map(([fieldName, fieldValidator]) => {
			const crdtValidator = fieldValidator as unknown as CrdtValidator;
			const type = getCrdtType(crdtValidator);
			const extractor = fieldExtractors.get(type);
			const extra = extractor ? extractor(crdtValidator) : {};
			return { field: fieldName, type, ...extra };
		});
}

export function emptyProse(): { type: 'doc'; content: never[] } {
	return { type: 'doc', content: [] };
}
