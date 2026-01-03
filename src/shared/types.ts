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

export type ProseValue = XmlFragmentJSON;

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

type SizeUnit = "kb" | "mb" | "gb";
export type Size = `${number}${SizeUnit}`;

type DurationUnit = "m" | "h" | "d";
export type Duration = `${number}${DurationUnit}`;

export interface CompactionConfig {
  sizeThreshold: Size;
  peerTimeout: Duration;
}

const SIZE_MULTIPLIERS: Record<SizeUnit, number> = {
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
};

const DURATION_MULTIPLIERS: Record<DurationUnit, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseSize(s: Size): number {
  const match = /^(\d+)(kb|mb|gb)$/i.exec(s);
  if (!match) throw new Error(`Invalid size: ${s}`);
  const [, num, unit] = match;
  return parseInt(num) * SIZE_MULTIPLIERS[unit.toLowerCase() as SizeUnit];
}

export function parseDuration(s: Duration): number {
  const match = /^(\d+)(m|h|d)$/i.exec(s);
  if (!match) throw new Error(`Invalid duration: ${s}`);
  const [, num, unit] = match;
  return parseInt(num) * DURATION_MULTIPLIERS[unit.toLowerCase() as DurationUnit];
}
