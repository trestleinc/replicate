import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";

const DEFAULT_HEARTBEAT_INTERVAL = 10000;
const DEFAULT_THROTTLE_MS = 50;

interface AwarenessApi {
  mark: FunctionReference<"mutation">;
  sessions: FunctionReference<"query">;
  cursors: FunctionReference<"query">;
  leave: FunctionReference<"mutation">;
}

export interface UserIdentity {
  name?: string;
  color?: string;
  avatar?: string;
}

export interface ConvexAwarenessConfig {
  convexClient: ConvexClient;
  api: AwarenessApi;
  document: string;
  client: string;
  ydoc: Y.Doc;
  interval?: number;
  syncReady?: Promise<void>;
  user?: UserIdentity;
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
    syncReady,
    user,
  } = config;

  const awareness = new Awareness(ydoc);

  if (user) {
    awareness.setLocalStateField("user", user);
  }

  let destroyed = false;
  let visible = true;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pendingUpdate: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeCursors: (() => void) | undefined;
  let unsubscribeVisibility: (() => void) | undefined;
  let unsubscribePageHide: (() => void) | undefined;

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
      return serialized;
    }
    catch {
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
      const profile: { name?: string; color?: string; avatar?: string } = {};
      if (typeof user.name === "string") profile.name = user.name;
      if (typeof user.color === "string") profile.color = user.color;
      if (typeof user.avatar === "string") profile.avatar = user.avatar;

      if (Object.keys(profile).length > 0) {
        return { profile };
      }
    }

    return {};
  };

  const sendToServer = () => {
    if (destroyed || !visible) return;

    const localState = awareness.getLocalState();
    const cursor = extractCursorFromState(localState);
    const { user, profile } = extractUserFromState(localState);
    const vector = getVector();

    convexClient.mutation(api.mark, {
      document,
      client,
      cursor,
      user,
      profile,
      interval,
      vector,
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
              name: remote.profile?.name ?? remote.user ?? getStableAnonName(remote.client),
              color: remote.profile?.color ?? getStableAnonColor(remote.client),
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
        });
      }
      else if (!wasVisible && visible) {
        sendToServer();
      }
    };

    globalThis.document.addEventListener("visibilitychange", handler);
    unsubscribeVisibility = () => {
      globalThis.document.removeEventListener("visibilitychange", handler);
    };
  };

  const setupPageHideHandler = () => {
    if (typeof globalThis.window === "undefined") return;

    const handler = (e: PageTransitionEvent) => {
      if (e.persisted) return;
      if (destroyed) return;

      convexClient.mutation(api.leave, { document, client });
    };

    globalThis.window.addEventListener("pagehide", handler);
    unsubscribePageHide = () => {
      globalThis.window.removeEventListener("pagehide", handler);
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

  awareness.on("update", onLocalAwarenessUpdate);
  subscribeToPresence();
  setupVisibilityHandler();
  setupPageHideHandler();

  let startTimeout: ReturnType<typeof setTimeout> | null = null;

  const initHeartbeat = async () => {
    if (syncReady) {
      await syncReady;
    }
    if (!destroyed) {
      startHeartbeat();
    }
  };

  startTimeout = setTimeout(() => {
    initHeartbeat();
  }, 0);

  return {
    awareness,
    document: ydoc,

    destroy: () => {
      if (destroyed) return;
      destroyed = true;

      if (startTimeout) {
        clearTimeout(startTimeout);
        startTimeout = null;
      }
      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
        pendingUpdate = null;
      }
      stopHeartbeat();
      awareness.off("update", onLocalAwarenessUpdate);
      unsubscribeCursors?.();
      unsubscribeVisibility?.();
      unsubscribePageHide?.();

      for (const clientId of remoteClientIds.values()) {
        awareness.states.delete(clientId);
      }
      remoteClientIds.clear();
      awareness.emit("update", [{ added: [], updated: [], removed: [] }, "remote"]);

      convexClient.mutation(api.leave, { document, client });

      awareness.destroy();
    },
  };
}

function hashStringToNumber(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

const ANONYMOUS_ADJECTIVES = [
  "Swift", "Bright", "Calm", "Bold", "Keen",
  "Quick", "Warm", "Cool", "Sharp", "Gentle",
];

const ANONYMOUS_NOUNS = [
  "Fox", "Owl", "Bear", "Wolf", "Hawk",
  "Deer", "Lynx", "Crow", "Hare", "Seal",
];

const ANONYMOUS_COLORS = [
  "#9F5944", "#A9704D", "#B08650", "#8A7D3F", "#6E7644",
  "#8C4A42", "#9E7656", "#9A5240", "#987C4A", "#7A8B6E",
];

function getStableAnonName(clientId: string): string {
  const hash = hashStringToNumber(clientId);
  const adj = ANONYMOUS_ADJECTIVES[hash % ANONYMOUS_ADJECTIVES.length];
  const noun = ANONYMOUS_NOUNS[(hash >> 4) % ANONYMOUS_NOUNS.length];
  return `${adj} ${noun}`;
}

function getStableAnonColor(clientId: string): string {
  const hash = hashStringToNumber(clientId);
  return ANONYMOUS_COLORS[(hash >> 8) % ANONYMOUS_COLORS.length];
}
