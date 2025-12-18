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
 * Extract field names from T where the value type is XmlFragmentJSON.
 * Used for type-safe prose field configuration.
 *
 * @example
 * ```typescript
 * interface Notebook {
 *   id: string;
 *   title: string;
 *   content: XmlFragmentJSON;
 * }
 *
 * type Fields = ProseFields<Notebook>; // 'content'
 * ```
 */
export type ProseFields<T> = {
  [K in keyof T]: T[K] extends XmlFragmentJSON ? K : never;
}[keyof T];
