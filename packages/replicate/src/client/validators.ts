import type { GenericValidator } from "convex/values";

interface ValidatorShape {
	kind: string;
	fields?: Record<string, ValidatorShape>;
	value?: unknown;
	isOptional?: "required" | "optional";
}

function isProseValidator(validator: GenericValidator): boolean {
	const v = validator as unknown as ValidatorShape;

	if (v.kind !== "object" || !v.fields) return false;

	const { type, content } = v.fields;

	if (!type || type.kind !== "literal" || type.value !== "doc") {
		return false;
	}

	if (!content) return false;

	const contentValidator = content.isOptional === "optional" ? content : content;
	return contentValidator.kind === "array" || (content.kind === "object" && !!content.fields);
}

export function findProseFields(validator: GenericValidator): string[] {
	const v = validator as unknown as ValidatorShape;

	if (v.kind !== "object" || !v.fields) return [];

	const proseFields: string[] = [];

	for (const [fieldName, fieldValidator] of Object.entries(v.fields)) {
		if (isProseValidator(fieldValidator as unknown as GenericValidator)) {
			proseFields.push(fieldName);
		}
	}

	return proseFields;
}

export function emptyProse(): { type: "doc"; content: never[] } {
	return { type: "doc", content: [] };
}
