//#region src/shared/types.d.ts

/** ProseMirror-compatible JSON for XmlFragment serialization */
interface XmlFragmentJSON {
  type: "doc";
  content?: XmlNodeJSON[];
}
declare const PROSE_BRAND: unique symbol;
/**
 * Branded prose type for Zod schemas.
 * Extends XmlFragmentJSON with a unique brand for type-level detection.
 * Use the `prose()` helper from `@trestleinc/replicate/client` to create this type.
 */
interface ProseValue extends XmlFragmentJSON {
  readonly [PROSE_BRAND]: typeof PROSE_BRAND;
}
/** ProseMirror node structure */
interface XmlNodeJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: XmlNodeJSON[];
  text?: string;
  marks?: {
    type: string;
    attrs?: Record<string, unknown>;
  }[];
}
//#endregion
export { type ProseValue, type XmlFragmentJSON, type XmlNodeJSON };