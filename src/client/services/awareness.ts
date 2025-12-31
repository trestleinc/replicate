import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { getLogger } from "$/client/logger";

const logger = getLogger(["replicate", "awareness"]);

const DEFAULT_HEARTBEAT_INTERVAL = 10000;
const DEFAULT_THROTTLE_MS = 50;

interface AwarenessApi {
  mark: FunctionReference<"mutation">;
  sessions: FunctionReference<"query">;
  cursors: FunctionReference<"query">;
  leave: FunctionReference<"mutation">;
}

export interface ConvexAwarenessConfig {
  convexClient: ConvexClient;
  api: AwarenessApi;
  document: string;
  client: string;
  ydoc: Y.Doc;
  interval?: number;
}

export interface ConvexAwarenessProvider {
  awareness: Awareness;
  document: Y.Doc;
  destroy: () => void;
}

/**
 * Creates a Yjs Awareness instance backed by Convex for transport.
 * This provider syncs awareness state (cursors, user info) via Convex
 * mutations and queries instead of WebSocket.
 *
 * Compatible with TipTap's CollaborationCursor and BlockNote's collaboration.
 */
export function createAwarenessProvider(
  config: ConvexAwarenessConfig,
): ConvexAwarenessProvider {
  const {
    convexClient,
    api,
    document,
    client,
    ydoc,
    interval = DEFAULT_HEARTBEAT_INTERVAL,
  } = config;

  // Guard against SSR - awareness should only be created on client
  if (typeof globalThis.window === "undefined") {
    logger.warn("Awareness provider created in non-browser environment");
  }

  const awareness = new Awareness(ydoc);
  let destroyed = false;
  let visible = true;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pendingUpdate: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeCursors: (() => void) | undefined;
  let unsubscribeVisibility: (() => void) | undefined;

  // Track remote client IDs we know about
  const remoteClientIds = new Map<string, number>();

  const getVector = (): ArrayBuffer | undefined => {
    return Y.encodeStateVector(ydoc).buffer as ArrayBuffer;
  };

  /**
   * Extract cursor from awareness state for Convex storage.
   * y-prosemirror stores cursor as RelativePosition class instances.
   * We serialize to plain JSON objects for Convex storage.
   */
  const extractCursorFromState = (state: Record<string, unknown> | null): {
    anchor: unknown;
    head: unknown;
  } | undefined => {
    if (!state) return undefined;

    const cursor = state.cursor as {
      anchor?: unknown;
      head?: unknown;
    } | undefined | null;

    if (cursor?.anchor === undefined || cursor.head === undefined) {
      return undefined;
    }

    try {
      const serialized = {
        anchor: JSON.parse(JSON.stringify(cursor.anchor)),
        head: JSON.parse(JSON.stringify(cursor.head)),
      };
      logger.debug("Cursor extracted", {
        hasAnchor: !!serialized.anchor,
        hasHead: !!serialized.head,
      });
      return serialized;
    }
    catch (e) {
      logger.warn("Failed to serialize cursor", { error: String(e) });
      return undefined;
    }
  };

  /**
   * Extract user profile from awareness state.
   */
  const extractUserFromState = (state: Record<string, unknown> | null): {
    user?: string;
    profile?: { name?: string; color?: string; avatar?: string };
  } => {
    if (!state) return {};

    const user = state.user as
      | { name?: string; color?: string; [key: string]: unknown }
      | undefined;
    if (user) {
      return {
        profile: {
          name: user.name,
          color: user.color,
          avatar: user.avatar as string | undefined,
        },
      };
    }

    return {};
  };

  const sendToServer = () => {
    if (destroyed || !visible) return;

    const localState = awareness.getLocalState();
    const cursor = extractCursorFromState(localState);
    const { user, profile } = extractUserFromState(localState);
    const vector = getVector();

    logger.debug("Sending awareness to server", {
      document,
      client,
      hasCursor: !!cursor,
      cursor,
      hasProfile: !!profile,
      localStateKeys: localState ? Object.keys(localState) : [],
    });

    convexClient.mutation(api.mark, {
      document,
      client,
      cursor,
      user,
      profile,
      interval,
      vector,
    }).catch((error) => {
      logger.warn("Failed to send awareness to server", { error: String(error) });
    });
  };

  /**
   * Throttled version of sendToServer for frequent updates.
   */
  const throttledSend = () => {
    if (pendingUpdate) return;

    pendingUpdate = setTimeout(() => {
      pendingUpdate = null;
      sendToServer();
    }, DEFAULT_THROTTLE_MS);
  };

  /**
   * Handle local awareness changes.
   */
  const onLocalAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    // Only send if the change is local (not from applying remote state)
    if (origin === "remote") return;

    // Check if our client was updated
    const localClientId = awareness.clientID;
    if (
      changes.added.includes(localClientId)
      || changes.updated.includes(localClientId)
    ) {
      throttledSend();
    }
  };

  const subscribeToPresence = () => {
    unsubscribeCursors = convexClient.onUpdate(
      api.sessions,
      { document, connected: true, exclude: client },
      (remotes: {
        client: string;
        document: string;
        user?: string;
        profile?: { name?: string; color?: string; avatar?: string };
        cursor?: { anchor: unknown; head: unknown; field?: string };
      }[]) => {
        if (destroyed) return;

        const validRemotes = remotes.filter(r => r.document === document);

        if (validRemotes.length !== remotes.length) {
          logger.warn("Filtered sessions for wrong document", {
            expected: document,
            received: remotes.length,
            valid: validRemotes.length,
          });
        }

        logger.debug("Presence received", { document, count: validRemotes.length });

        const currentRemotes = new Set<string>();

        for (const remote of validRemotes) {
          currentRemotes.add(remote.client);

          let remoteClientId = remoteClientIds.get(remote.client);
          if (!remoteClientId) {
            remoteClientId = hashStringToNumber(remote.client);
            remoteClientIds.set(remote.client, remoteClientId);
          }

          const remoteState: Record<string, unknown> = {
            user: {
              name: remote.profile?.name ?? remote.user ?? "Anonymous",
              color: remote.profile?.color ?? getColorForClient(remote.client),
              avatar: remote.profile?.avatar,
              clientId: remote.client,
            },
          };

          if (remote.cursor) {
            remoteState.cursor = remote.cursor;
          }

          awareness.states.set(remoteClientId, remoteState);
        }

        for (const [clientStr, clientId] of remoteClientIds) {
          if (!currentRemotes.has(clientStr)) {
            awareness.states.delete(clientId);
            remoteClientIds.delete(clientStr);
          }
        }

        awareness.emit("update", [
          { added: [], updated: Array.from(remoteClientIds.values()), removed: [] },
          "remote",
        ]);
      },
    );
  };

  /**
   * Handle visibility changes - clear cursor when tab is hidden.
   */
  const setupVisibilityHandler = () => {
    if (typeof globalThis.document === "undefined") return;

    const handler = () => {
      const wasVisible = visible;
      visible = globalThis.document.visibilityState === "visible";

      if (wasVisible && !visible) {
        convexClient.mutation(api.mark, {
          document,
          client,
          cursor: undefined,
          interval,
          vector: getVector(),
        }).catch((error) => {
          logger.warn("Failed to clear cursor on visibility change", { error: String(error) });
        });
      }
      else if (!wasVisible && visible) {
        // Tab visible again - resend current state
        sendToServer();
      }
    };

    globalThis.document.addEventListener("visibilitychange", handler);
    unsubscribeVisibility = () => {
      globalThis.document.removeEventListener("visibilitychange", handler);
    };
  };

  /**
   * Start periodic heartbeat to keep presence alive.
   */
  const startHeartbeat = () => {
    sendToServer();
    heartbeatTimer = setInterval(sendToServer, interval);
  };

  /**
   * Stop heartbeat.
   */
  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  // Set up listeners
  awareness.on("update", onLocalAwarenessUpdate);
  subscribeToPresence();
  setupVisibilityHandler();

  // Start heartbeat after a tick to allow user to set initial state
  const startTimeout = setTimeout(() => {
    if (!destroyed) {
      startHeartbeat();
    }
  }, 0);

  logger.info("Awareness provider created", { document, client });

  return {
    awareness,
    document: ydoc,

    destroy: () => {
      if (destroyed) return;
      destroyed = true;

      logger.debug("Awareness provider destroying", { document, client });

      clearTimeout(startTimeout);
      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
        pendingUpdate = null;
      }
      stopHeartbeat();
      awareness.off("update", onLocalAwarenessUpdate);
      unsubscribeCursors?.();
      unsubscribeVisibility?.();

      for (const clientId of remoteClientIds.values()) {
        awareness.states.delete(clientId);
      }
      remoteClientIds.clear();
      awareness.emit("update", [{ added: [], updated: [], removed: [] }, "remote"]);

      convexClient.mutation(api.leave, { document, client }).catch((error) => {
        logger.warn("Leave mutation failed", { error: String(error) });
      });

      awareness.destroy();
    },
  };
}

/**
 * Hash a string to a positive number for use as clientId.
 */
function hashStringToNumber(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Generate a color for a client based on their ID.
 */
const DEFAULT_COLORS = [
  "#F87171", "#FB923C", "#FBBF24", "#A3E635",
  "#34D399", "#22D3EE", "#60A5FA", "#A78BFA", "#F472B6",
];

function getColorForClient(clientId: string): string {
  const hash = hashStringToNumber(clientId);
  return DEFAULT_COLORS[hash % DEFAULT_COLORS.length];
}
