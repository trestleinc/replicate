import { PUBLIC_CONVEX_URL } from '$env/static/public';
import { z } from 'zod';

// Schema for required public environment variables
const publicEnvSchema = z.object({
	PUBLIC_CONVEX_URL: z.string().url('PUBLIC_CONVEX_URL must be a valid URL'),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

// Validate at module load time and cache result
const _validationResult = publicEnvSchema.safeParse({ PUBLIC_CONVEX_URL });
const _publicEnvError: string[] | null = _validationResult.success
	? null
	: _validationResult.error.issues.map((i) => i.path.join('.'));

export function getPublicEnv(): PublicEnv {
	if (_publicEnvError) {
		throw new Error(`Missing environment variables: ${_publicEnvError.join(', ')}`);
	}
	return { PUBLIC_CONVEX_URL };
}

export function getPublicEnvError(): string[] | null {
	return _publicEnvError;
}
