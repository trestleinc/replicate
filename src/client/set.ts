import type { ConvexClient } from 'convex/browser';
import type { FunctionReference } from 'convex/server';
import { Effect } from 'effect';
import { ensureProtocolVersion } from './services/protocol.js';
import { getLogger } from '$/client/logger.js';

const logger = getLogger(['replicate', 'set']);

let setPromise: Promise<void> | null = null;
let isSet = false;

/** Configuration options for verify (internal) */
interface VerifyOptions {
  /** The Convex client instance */
  convexClient: ConvexClient;
  /** API endpoints for the replicate component */
  api?: {
    /** Protocol version query endpoint */
    protocol?: FunctionReference<'query'>;
  };
}

/**
 * Verify the Replicate client protocol version.
 * Internal function - called automatically by convexCollectionOptions.
 *
 * @param options - Configuration options including convexClient and api endpoints
 * @throws Error if protocol endpoint is not provided or setup fails
 */
async function verify(options: VerifyOptions): Promise<void> {
  const { convexClient, api } = options;

  logger.info('Verifying Replicate protocol');

  try {
    if (!api?.protocol) {
      throw new Error(
        'No protocol version endpoint provided. Add a protocol query wrapper in your Convex app:\n\n' +
          'export const protocol = query({\n  handler: async (ctx) => {\n    return await ctx.runQuery(components.replicate.public.protocol);\n  },\n});\n\n' +
          'Then pass it to convexCollectionOptions:\n' +
          'convexCollectionOptions({ api: { protocol: api.replicate.protocol }, ... });'
      );
    }

    // Use ProtocolService via ensureProtocolVersion (Effect-based)
    const version = await Effect.runPromise(
      ensureProtocolVersion(convexClient, { protocol: api.protocol })
    );

    logger.info('Replicate verification complete', { version });
  } catch (error) {
    logger.error('Failed to verify Replicate', { error });
    throw new Error(
      `Replicate verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Ensure Replicate is initialized, running verification lazily if needed.
 * Safe to call multiple times - only initializes once.
 *
 * @param options - Configuration options
 * @returns Promise that resolves when verification is complete
 */
export function ensureSet(options: VerifyOptions): Promise<void> {
  if (isSet) {
    return Promise.resolve();
  }

  if (setPromise) {
    return setPromise;
  }

  logger.debug('Auto-verifying Replicate (lazy setup)');

  setPromise = verify(options)
    .then(() => {
      isSet = true;
      logger.info('Replicate auto-verification successful');
    })
    .catch((error) => {
      setPromise = null;
      logger.error('Auto-verification failed', { error });

      throw new Error(
        `Replicate auto-verification failed: ${error instanceof Error ? error.message : 'Unknown error'}\n` +
          'This likely means the replicate component is not installed in your Convex backend.\n' +
          'See: https://github.com/trestleinc/replicate#installation'
      );
    });

  return setPromise;
}

// Internal - for test cleanup only
export function _resetSetState(): void {
  setPromise = null;
  isSet = false;
}
