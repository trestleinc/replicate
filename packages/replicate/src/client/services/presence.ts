import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import type { AnonymousPresenceConfig, UserIdentity } from "$/client/identity";

const DEFAULT_HEARTBEAT_MS = 10000;
const DEFAULT_THROTTLE_MS = 50;

const DEFAULT_ADJECTIVES = [
	"Swift",
	"Bright",
	"Calm",
	"Bold",
	"Keen",
	"Quick",
	"Warm",
	"Cool",
	"Sharp",
	"Gentle",
];

const DEFAULT_NOUNS = [
	"Fox",
	"Owl",
	"Bear",
	"Wolf",
	"Hawk",
	"Deer",
	"Lynx",
	"Crow",
	"Hare",
	"Seal",
];

const DEFAULT_COLORS = [
	"#9F5944",
	"#A9704D",
	"#B08650",
	"#8A7D3F",
	"#6E7644",
	"#8C4A42",
	"#9E7656",
	"#9A5240",
	"#987C4A",
	"#7A8B6E",
];

interface PresenceApi {
	presence: FunctionReference<"mutation">;
	session: FunctionReference<"query">;
}

export interface PresenceState {
	local: UserIdentity | null;
	remote: UserIdentity[];
}

export interface Presence {
	join(options?: { cursor?: unknown }): void;
	leave(): void;
	update(options: { cursor?: unknown }): void;
	get(): PresenceState;
	subscribe(callback: (state: PresenceState) => void): () => void;
}

export interface PresenceConfig {
	convexClient: ConvexClient;
	api: PresenceApi;
	document: string;
	client: string;
	ydoc: Y.Doc;
	heartbeatMs?: number;
	throttleMs?: number;
	syncReady?: Promise<void>;
	user?: () => UserIdentity | undefined;
	anonymousPresence?: AnonymousPresenceConfig;
}

export interface PresenceProvider extends Presence {
	awareness: Awareness;
	destroy(): void;
}

type PresenceLifecycleState = "idle" | "joining" | "active" | "leaving" | "destroyed";

interface PresencePayload {
	action: "join" | "leave";
	cursor?: unknown;
	user?: string;
	profile?: { name?: string; color?: string; avatar?: string };
	vector?: ArrayBuffer;
}

interface FlightStatus {
	inFlight: boolean;
	pending: PresencePayload | null;
}

export function hashStringToNumber(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash;
	}
	return Math.abs(hash);
}

export function getStableAnonName(clientId: string, config?: AnonymousPresenceConfig): string {
	const adjectives = config?.adjectives ?? DEFAULT_ADJECTIVES;
	const nouns = config?.nouns ?? DEFAULT_NOUNS;
	const hash = hashStringToNumber(clientId);
	const adj = adjectives[hash % adjectives.length];
	const noun = nouns[(hash >> 4) % nouns.length];
	return `${adj} ${noun}`;
}

export function getStableAnonColor(clientId: string, config?: AnonymousPresenceConfig): string {
	const colors = config?.colors ?? DEFAULT_COLORS;
	const hash = hashStringToNumber(clientId);
	return colors[(hash >> 8) % colors.length];
}

export function createPresence(config: PresenceConfig): PresenceProvider {
	const {
		convexClient,
		api,
		document,
		client,
		ydoc,
		heartbeatMs = DEFAULT_HEARTBEAT_MS,
		throttleMs = DEFAULT_THROTTLE_MS,
		syncReady,
		user: userGetter,
		anonymousPresence,
	} = config;

	const awareness = new Awareness(ydoc);
	const resolvedUser = userGetter?.();

	if (resolvedUser) {
		awareness.setLocalStateField("user", resolvedUser);
	}

	let state: PresenceLifecycleState = "idle";
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
	const subscribers = new Set<(state: PresenceState) => void>();

	const getVector = (): ArrayBuffer | undefined => {
		return Y.encodeStateVector(ydoc).buffer as ArrayBuffer;
	};

	const extractCursorFromState = (
		awarenessState: Record<string, unknown> | null,
	): { anchor: unknown; head: unknown } | undefined => {
		if (!awarenessState) return undefined;

		const cursor = awarenessState.cursor as { anchor?: unknown; head?: unknown } | undefined | null;

		if (cursor?.anchor === undefined || cursor.head === undefined) {
			return undefined;
		}

		try {
			return {
				anchor: JSON.parse(JSON.stringify(cursor.anchor)),
				head: JSON.parse(JSON.stringify(cursor.head)),
			};
		} catch {
			return undefined;
		}
	};

	const extractUserFromState = (
		awarenessState: Record<string, unknown> | null,
	): {
		user?: string;
		profile?: { name?: string; color?: string; avatar?: string };
	} => {
		if (!awarenessState) return {};

		const userState = awarenessState.user as
			| { id?: string; name?: string; color?: string; avatar?: string; [key: string]: unknown }
			| undefined;

		if (userState) {
			const result: {
				user?: string;
				profile?: { name?: string; color?: string; avatar?: string };
			} = {};

			if (typeof userState.id === "string") {
				result.user = userState.id;
			}

			const profile: { name?: string; color?: string; avatar?: string } = {};
			if (typeof userState.name === "string") profile.name = userState.name;
			if (typeof userState.color === "string") profile.color = userState.color;
			if (typeof userState.avatar === "string") profile.avatar = userState.avatar;

			if (Object.keys(profile).length > 0) {
				result.profile = profile;
			}

			return result;
		}

		return {};
	};

	const buildJoinPayload = (cursorOverride?: unknown): PresencePayload => {
		const localState = awareness.getLocalState();
		const cursor = cursorOverride ?? extractCursorFromState(localState);
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
			interval: payload.action === "join" ? heartbeatMs : undefined,
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
		} finally {
			while (flightStatus.pending && !isDestroyed()) {
				const next = flightStatus.pending;
				flightStatus.pending = null;
				try {
					await executePresence(next);
				} catch {
					break;
				}
			}
			flightStatus.inFlight = false;
		}
	};

	const transitionTo = (newState: PresenceLifecycleState): boolean => {
		const validTransitions: Record<PresenceLifecycleState, PresenceLifecycleState[]> = {
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

	const notifySubscribers = (): void => {
		const presenceState = getPresenceState();
		subscribers.forEach(cb => cb(presenceState));
	};

	const getPresenceState = (): PresenceState => {
		const localState = awareness.getLocalState();
		const localUser = localState?.user as UserIdentity | undefined;

		const remote: UserIdentity[] = [];
		for (const [clientStr] of remoteClientIds) {
			const clientId = remoteClientIds.get(clientStr);
			if (clientId !== undefined) {
				const remoteState = awareness.states.get(clientId);
				if (remoteState?.user) {
					remote.push(remoteState.user as UserIdentity);
				}
			}
		}

		return {
			local: localUser ?? null,
			remote,
		};
	};

	const joinPresence = (cursorOverride?: unknown): void => {
		if (state === "destroyed" || !visible) return;

		if (state === "idle" || state === "leaving") {
			transitionTo("joining");
		}

		const payload = buildJoinPayload(cursorOverride);
		sendWithSingleFlight(payload).then(() => {
			if (state === "joining") {
				transitionTo("active");
			}
		});
	};

	const leavePresence = (): void => {
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
				joinPresence();
			}
		}, throttleMs);
	};

	const onLocalAwarenessUpdate = (
		changes: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	): void => {
		if (origin === "remote") return;
		if (state === "destroyed") return;

		const localClientId = awareness.clientID;
		if (changes.added.includes(localClientId) || changes.updated.includes(localClientId)) {
			throttledJoin();
		}
	};

	const subscribeToPresence = (): void => {
		unsubscribeCursors = convexClient.onUpdate(
			api.session,
			{ document, connected: true, exclude: client },
			(
				remotes: {
					client: string;
					document: string;
					user?: string;
					profile?: { name?: string; color?: string; avatar?: string };
					cursor?: { anchor: unknown; head: unknown; field?: string };
				}[],
			) => {
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
							id: remote.user,
							name:
								remote.profile?.name ??
								remote.user ??
								getStableAnonName(remote.client, anonymousPresence),
							color: remote.profile?.color ?? getStableAnonColor(remote.client, anonymousPresence),
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

				notifySubscribers();
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
				leavePresence();
			} else if (!wasVisible && visible && state === "active") {
				joinPresence();
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

		heartbeatTimer = setInterval(() => {
			if (state !== "destroyed" && visible && state === "active") {
				joinPresence();
			}
		}, heartbeatMs);
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

		join(options?: { cursor?: unknown }): void {
			joinPresence(options?.cursor);
		},

		leave(): void {
			leavePresence();
		},

		update(options: { cursor?: unknown }): void {
			if (state === "destroyed") return;
			awareness.setLocalStateField("cursor", options.cursor);
		},

		get(): PresenceState {
			return getPresenceState();
		},

		subscribe(callback: (state: PresenceState) => void): () => void {
			subscribers.add(callback);
			callback(getPresenceState());
			return () => subscribers.delete(callback);
		},

		destroy(): void {
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
			subscribers.clear();

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
