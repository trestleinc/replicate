import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";

const DEFAULT_HEARTBEAT_INTERVAL = 10000;
const DEFAULT_THROTTLE_MS = 50;

interface AwarenessApi {
  presence: FunctionReference<"mutation">;
  sessions: FunctionReference<"query">;
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

type PresenceState = "idle" | "joining" | "active" | "leaving" | "destroyed";

interface FlightStatus {
  inFlight: boolean;
  pending: PresencePayload | null;
}

interface PresencePayload {
  action: "join" | "leave";
  cursor?: { anchor: unknown; head: unknown };
  user?: string;
  profile?: { name?: string; color?: string; avatar?: string };
  vector?: ArrayBuffer;
}

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

  let state: PresenceState = "idle";
  let visible = true;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let startTimeout: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeCursors: (() => void) | undefined;
  let unsubscribeVisibility: (() => void) | undefined;
  let unsubscribePageHide: (() => void) | undefined;

  const flightStatus: FlightStatus = {
    inFlight: false,
    pending: null,
  };

  const remoteClientIds = new Map<string, number>();

  const getVector = (): ArrayBuffer | undefined => {
    return Y.encodeStateVector(ydoc).buffer as ArrayBuffer;
  };

  const extractCursorFromState = (awarenessState: Record<string, unknown> | null): {
    anchor: unknown;
    head: unknown;
  } | undefined => {
    if (!awarenessState) return undefined;

    const cursor = awarenessState.cursor as {
      anchor?: unknown;
      head?: unknown;
    } | undefined | null;

    if (cursor?.anchor === undefined || cursor.head === undefined) {
      return undefined;
    }

    try {
      return {
        anchor: JSON.parse(JSON.stringify(cursor.anchor)),
        head: JSON.parse(JSON.stringify(cursor.head)),
      };
    }
    catch {
      return undefined;
    }
  };

  const extractUserFromState = (awarenessState: Record<string, unknown> | null): {
    user?: string;
    profile?: { name?: string; color?: string; avatar?: string };
  } => {
    if (!awarenessState) return {};

    const userState = awarenessState.user as
      | { name?: string; color?: string; avatar?: string; [key: string]: unknown }
      | undefined;

    if (userState) {
      const profile: { name?: string; color?: string; avatar?: string } = {};
      if (typeof userState.name === "string") profile.name = userState.name;
      if (typeof userState.color === "string") profile.color = userState.color;
      if (typeof userState.avatar === "string") profile.avatar = userState.avatar;

      if (Object.keys(profile).length > 0) {
        return { profile };
      }
    }

    return {};
  };

  const buildJoinPayload = (): PresencePayload => {
    const localState = awareness.getLocalState();
    const cursor = extractCursorFromState(localState);
    const { user: userId, profile } = extractUserFromState(localState);
    const vector = getVector();

    return {
      action: "join",
      cursor,
      user: userId,
      profile,
      vector,
    };
  };

  const executePresence = async (payload: PresencePayload): Promise<void> => {
    await convexClient.mutation(api.presence, {
      document,
      client,
      action: payload.action,
      cursor: payload.cursor,
      user: payload.user,
      profile: payload.profile,
      interval: payload.action === "join" ? interval : undefined,
      vector: payload.vector,
    });
  };

  const isDestroyed = (): boolean => state === "destroyed";

  const sendWithSingleFlight = async (payload: PresencePayload): Promise<void> => {
    if (isDestroyed()) return;

    if (flightStatus.inFlight) {
      flightStatus.pending = payload;
      return;
    }

    flightStatus.inFlight = true;

    try {
      await executePresence(payload);
    }
    finally {
      while (flightStatus.pending && !isDestroyed()) {
        const next = flightStatus.pending;
        flightStatus.pending = null;
        try {
          await executePresence(next);
        }
        catch {
          break;
        }
      }
      flightStatus.inFlight = false;
    }
  };

  const transitionTo = (newState: PresenceState): boolean => {
    const validTransitions: Record<PresenceState, PresenceState[]> = {
      idle: ["joining", "destroyed"],
      joining: ["active", "leaving", "destroyed"],
      active: ["leaving", "destroyed"],
      leaving: ["idle", "joining", "destroyed"],
      destroyed: [],
    };

    if (!validTransitions[state].includes(newState)) {
      return false;
    }

    state = newState;
    return true;
  };

  const join = (): void => {
    if (state === "destroyed" || !visible) return;

    if (state === "idle" || state === "leaving") {
      transitionTo("joining");
    }

    const payload = buildJoinPayload();
    sendWithSingleFlight(payload).then(() => {
      if (state === "joining") {
        transitionTo("active");
      }
    });
  };

  const leave = (): void => {
    if (state === "destroyed") return;
    if (state === "idle") return;

    transitionTo("leaving");

    sendWithSingleFlight({ action: "leave" }).then(() => {
      if (state === "leaving") {
        transitionTo("idle");
      }
    });
  };

  const throttledJoin = (): void => {
    if (throttleTimer) return;
    if (state === "destroyed") return;

    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      if (visible) {
        join();
      }
    }, DEFAULT_THROTTLE_MS);
  };

  const onLocalAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === "remote") return;
    if (state === "destroyed") return;

    const localClientId = awareness.clientID;
    if (
      changes.added.includes(localClientId)
      || changes.updated.includes(localClientId)
    ) {
      throttledJoin();
    }
  };

  const subscribeToPresence = (): void => {
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
        if (state === "destroyed") return;

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

  const setupVisibilityHandler = (): void => {
    if (typeof globalThis.document === "undefined") return;

    const handler = (): void => {
      if (state === "destroyed") return;

      const wasVisible = visible;
      visible = globalThis.document.visibilityState === "visible";

      if (wasVisible && !visible) {
        leave();
      }
      else if (!wasVisible && visible) {
        join();
      }
    };

    globalThis.document.addEventListener("visibilitychange", handler);
    unsubscribeVisibility = () => {
      globalThis.document.removeEventListener("visibilitychange", handler);
    };
  };

  const setupPageHideHandler = (): void => {
    if (typeof globalThis.window === "undefined") return;

    const handler = (e: PageTransitionEvent): void => {
      if (e.persisted) return;
      if (state === "destroyed") return;

      convexClient.mutation(api.presence, {
        document,
        client,
        action: "leave" as const,
      });
    };

    globalThis.window.addEventListener("pagehide", handler);
    unsubscribePageHide = () => {
      globalThis.window.removeEventListener("pagehide", handler);
    };
  };

  const startHeartbeat = (): void => {
    if (state === "destroyed") return;

    join();
    heartbeatTimer = setInterval(() => {
      if (state !== "destroyed" && visible) {
        join();
      }
    }, interval);
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  awareness.on("update", onLocalAwarenessUpdate);
  subscribeToPresence();
  setupVisibilityHandler();
  setupPageHideHandler();

  const initHeartbeat = async (): Promise<void> => {
    if (syncReady) {
      await syncReady;
    }
    if (state !== "destroyed") {
      startHeartbeat();
    }
  };

  startTimeout = setTimeout(() => {
    initHeartbeat();
  }, 0);

  return {
    awareness,
    document: ydoc,

    destroy: (): void => {
      if (state === "destroyed") return;
      transitionTo("destroyed");

      if (startTimeout) {
        clearTimeout(startTimeout);
        startTimeout = null;
      }
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }

      flightStatus.pending = null;

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

      convexClient.mutation(api.presence, {
        document,
        client,
        action: "leave" as const,
      });

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
