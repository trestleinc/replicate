import { getStableAnonColor, getStableAnonName } from "$/client/services/presence";

/**
 * User identity for presence and collaborative features.
 */
export interface UserIdentity {
	id?: string;
	name?: string;
	color?: string;
	avatar?: string;
}

/**
 * Configuration for anonymous presence names and colors.
 * Allows applications to customize the adjectives, nouns, and colors
 * used when generating anonymous user identities.
 */
export interface AnonymousPresenceConfig {
	/** List of adjectives for anonymous names (e.g., ["Swift", "Bright", "Calm"]) */
	adjectives?: string[];
	/** List of nouns for anonymous names (e.g., ["Fox", "Owl", "Bear"]) */
	nouns?: string[];
	/** List of hex colors for anonymous users (e.g., ["#9F5944", "#A9704D"]) */
	colors?: string[];
}

/**
 * Identity namespace for creating user identities and generating stable anonymous identifiers.
 *
 * @example
 * ```typescript
 * import { identity } from "@trestleinc/replicate/client";
 *
 * // Create from your auth provider
 * const user = identity.from({
 *   id: authSession.user.id,
 *   name: authSession.user.name,
 *   avatar: authSession.user.image,
 *   color: identity.color.generate(authSession.user.id),
 * });
 *
 * // Generate stable anonymous identifiers
 * identity.color.generate("seed-123")    // Deterministic color
 * identity.name.anonymous("seed-123")    // "Swift Fox", "Calm Bear", etc.
 * ```
 */
export const identity = {
	/**
	 * Create a user identity from auth provider data.
	 * Pass-through helper that ensures type safety.
	 */
	from(user: UserIdentity): UserIdentity {
		return { ...user };
	},

	/**
	 * Color utilities for generating stable, deterministic colors.
	 */
	color: {
		/**
		 * Generate a deterministic color from any seed string.
		 * Same seed always produces the same color.
		 *
		 * @param seed - Any string (user ID, client ID, etc.)
		 * @param config - Optional custom colors configuration
		 * @returns Hex color string (e.g., "#9F5944")
		 */
		generate(seed: string, config?: AnonymousPresenceConfig): string {
			return getStableAnonColor(seed, config);
		},
	},

	/**
	 * Name utilities for generating stable anonymous names.
	 */
	name: {
		/**
		 * Generate a stable anonymous name from any seed string.
		 * Same seed always produces the same name.
		 *
		 * @param seed - Any string (user ID, client ID, etc.)
		 * @param config - Optional custom adjectives/nouns configuration
		 * @returns Anonymous name (e.g., "Swift Fox", "Calm Bear")
		 */
		anonymous(seed: string, config?: AnonymousPresenceConfig): string {
			return getStableAnonName(seed, config);
		},
	},
} as const;
