import { identity } from '@trestleinc/replicate/client';
import { getAuthClient } from '$lib/auth-client';
import type { MigrationError, RecoveryContext } from '@trestleinc/replicate/client';

/**
 * Shared user identity resolver for all collections.
 * Transforms auth session into a replicate identity object.
 */
export function resolveUserIdentity() {
	const authClient = getAuthClient();
	const store = authClient.useSession();
	const session = store.get();
	if (!session.data?.user) return undefined;
	return identity.from({
		id: session.data.user.id,
		name: session.data.user.name,
		avatar: session.data.user.image ?? undefined,
		color: identity.color.generate(session.data.user.id),
	});
}

/**
 * Shared migration error handler for all collections.
 * Resets if safe, otherwise keeps old schema.
 */
export async function handleMigrationError(
	error: MigrationError,
	context: RecoveryContext
): Promise<{ action: 'reset' } | { action: 'keep-old-schema' }> {
	console.error('Migration error:', error);
	if (context.canResetSafely) {
		return { action: 'reset' };
	}
	return { action: 'keep-old-schema' };
}
