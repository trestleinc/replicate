// This file is used by convex-test for loading component modules.
// The import.meta.glob is a Vite/Vitest feature that's available during testing.
export const modules = (import.meta as any).glob('./**/!(*.*.*)*.*s') as Record<
	string,
	() => Promise<unknown>
>;
