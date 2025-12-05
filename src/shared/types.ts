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
  type: 'doc';
  content?: XmlNodeJSON[];
}

/** ProseMirror node structure */
export interface XmlNodeJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: XmlNodeJSON[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

/** Operation type for streaming changes */
export enum OperationType {
  Delta = 'delta',
  Snapshot = 'snapshot',
}
