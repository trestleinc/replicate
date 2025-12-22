/**
 * Shared types for @trestleinc/replicate
 *
 * These types are used across client, server, and component code.
 * They are safe to import in any environment (browser, Node.js, Convex).
 */

/** Marker used during insert/update to signal a fragment field */
export interface FragmentValue {
  __xmlFragment: true;
  content?: XmlFragmentJSON;
}

/** ProseMirror-compatible JSON for XmlFragment serialization */
export interface XmlFragmentJSON {
  type: "doc";
  content?: XmlNodeJSON[];
}

declare const PROSE_BRAND: unique symbol;

/**
 * Branded prose type for Zod schemas.
 * Extends XmlFragmentJSON with a unique brand for type-level detection.
 * Use the `prose()` helper from `@trestleinc/replicate/client` to create this type.
 */
export interface ProseValue extends XmlFragmentJSON {
  readonly [PROSE_BRAND]: typeof PROSE_BRAND;
}

/** ProseMirror node structure */
export interface XmlNodeJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: XmlNodeJSON[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/** Operation type for streaming changes */
export enum OperationType {
  Delta = "delta",
  Snapshot = "snapshot",
}

/**
 * Extract prose field names from T (fields typed as ProseValue).
 * Used internally for type-safe prose field operations.
 */
export type ProseFields<T> = {
  [K in keyof T]: T[K] extends ProseValue ? K : never;
}[keyof T];
