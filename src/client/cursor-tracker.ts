import type { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { getLogger } from "$/client/logger";

const logger = getLogger(["replicate", "cursor"]);

export interface CursorPosition {
  anchor: number;
  head: number;
  field?: string;
}

export interface UserProfile {
  name?: string;
  color?: string;
  avatar?: string;
}

export interface ClientCursor {
  client: string;
  user?: string;
  profile?: UserProfile;
  cursor: CursorPosition;
}

interface CursorTrackerApi {
  mark: FunctionReference<"mutation">;
  cursors: FunctionReference<"query">;
  leave: FunctionReference<"mutation">;
}

interface CursorTrackerConfig {
  convexClient: ConvexClient;
  api: CursorTrackerApi;
  collection: string;
  document: string;
  client: string;
  field: string;
  user?: string;
  profile?: UserProfile;
}

const CURSOR_DEBOUNCE_MS = 200;

export class CursorTracker {
  private position: CursorPosition | null = null;
  private remoteClients = new Map<string, ClientCursor>();
  private convexClient: ConvexClient;
  private api: CursorTrackerApi;
  private collection: string;
  private document: string;
  private client: string;
  private field: string;
  private user?: string;
  private profile?: UserProfile;
  private unsubscribe?: () => void;
  private listeners = new Set<() => void>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPosition: CursorPosition | null = null;
  private destroyed = false;

  constructor(config: CursorTrackerConfig) {
    this.convexClient = config.convexClient;
    this.api = config.api;
    this.collection = config.collection;
    this.document = config.document;
    this.client = config.client;
    this.field = config.field;
    this.user = config.user;
    this.profile = config.profile;

    this.subscribeToServer();
    this.setupVisibilityHandlers();

    logger.debug("CursorTracker created", {
      collection: this.collection,
      document: this.document,
      client: this.client,
      field: this.field,
    });
  }

  get(): CursorPosition | null {
    return this.position;
  }

  update(position: Omit<CursorPosition, "field">): void {
    this.position = { ...position, field: this.field };
    this.pendingPosition = this.position;
    this.debouncedSync();
  }

  others(): Map<string, ClientCursor> {
    return new Map(this.remoteClients);
  }

  on(event: "change", cb: () => void): void {
    if (event === "change") {
      this.listeners.add(cb);
    }
  }

  off(event: "change", cb: () => void): void {
    if (event === "change") {
      this.listeners.delete(cb);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    logger.debug("CursorTracker destroying", {
      collection: this.collection,
      document: this.document,
    });

    this.unsubscribe?.();
    this.listeners.clear();

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    document.removeEventListener("visibilitychange", this.handleVisibility);
    window.removeEventListener("beforeunload", this.handleUnload);

    this.convexClient.mutation(this.api.leave, {
      document: this.document,
      client: this.client,
    }).catch((error) => {
      logger.warn("Leave mutation failed", { error: String(error) });
    });
  }

  private debouncedSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.syncToServer();
    }, CURSOR_DEBOUNCE_MS);
  }

  private async syncToServer(): Promise<void> {
    if (!this.pendingPosition || this.destroyed) return;

    const positionToSync = this.pendingPosition;
    this.pendingPosition = null;

    try {
      await this.convexClient.mutation(this.api.mark, {
        document: this.document,
        client: this.client,
        cursor: positionToSync,
        user: this.user,
        profile: this.profile,
      });

      logger.debug("Cursor synced", {
        document: this.document,
        cursor: positionToSync,
      });
    }
    catch (error) {
      logger.warn("Cursor sync failed", { error: String(error) });
    }
  }

  private subscribeToServer(): void {
    this.unsubscribe = this.convexClient.onUpdate(
      this.api.cursors,
      {
        document: this.document,
        exclude: this.client,
      },
      (clients: ClientCursor[]) => {
        this.remoteClients.clear();
        for (const c of clients) {
          this.remoteClients.set(c.client, c);
        }
        this.notifyListeners();
      },
    );
  }

  private notifyListeners(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      }
      catch (error) {
        logger.warn("Cursor change listener error", { error: String(error) });
      }
    }
  }

  private setupVisibilityHandlers(): void {
    document.addEventListener("visibilitychange", this.handleVisibility);
    window.addEventListener("beforeunload", this.handleUnload);
  }

  private handleVisibility = (): void => {
    if (document.hidden) {
      this.convexClient.mutation(this.api.leave, {
        document: this.document,
        client: this.client,
      }).catch((error) => {
        logger.warn("Leave on visibility change failed", { error: String(error) });
      });
    }
  };

  private handleUnload = (): void => {
    const url = (this.convexClient as any).address;
    if (url && navigator.sendBeacon) {
      const leaveUrl = `${url}/api/mutation`;
      const body = JSON.stringify({
        path: "leave",
        args: {
          document: this.document,
          client: this.client,
        },
      });
      navigator.sendBeacon(leaveUrl, body);
    }
  };
}
