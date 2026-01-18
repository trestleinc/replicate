# Identity, Presence & Encryption

This guide covers authentication, presence, sessions, and encryption in Replicate.

## Overview

Replicate uses a layered security model:

```
auth       = who you are (external provider)
view       = what you can see (server-side gate)
hooks      = what you can write (server-side gate)
encryption = data protection (client-side, works offline)
```

**Key insight**: Authentication (who you are) is separate from encryption (protecting data). This enables:

- Any auth provider (Clerk, WorkOS, Google OAuth, Better Auth)
- Passwordless encryption via biometrics (Touch ID / Face ID)
- Offline access to encrypted data

---

## API Design Principles

Replicate uses consistent naming patterns across all APIs:

| Pattern       | Example                     | Usage      |
| ------------- | --------------------------- | ---------- |
| `noun.noun`   | `persistence.web.sqlite`    | Namespaces |
| `noun.verb()` | `doc.presence.join()`       | Actions    |
| `noun.noun()` | `identity.color.generate()` | Utilities  |

**Naming conventions:**

- Tables: singular (`session`, `device`, `delta`)
- Server exports: singular (`session`, `delta`, `presence`)
- Hooks: short nouns (`change`, `passphrase`, `recovery`)

---

## Identity

The `identity` namespace bridges auth providers with presence and encryption.

```typescript
import { identity } from "@trestleinc/replicate/client";

// Create from your auth provider
const user = identity.from({
  id: authSession.user.id,
  name: authSession.user.name,
  avatar: authSession.user.image,
  color: identity.color.generate(authSession.user.id),
});

// Utilities
identity.color.generate(seed)    // Deterministic color from any string
identity.name.anonymous(seed)    // "Swift Fox", "Calm Bear", etc.
```

**Usage in collection:**

```typescript
export const tasks = collection.create(schema, "tasks", {
  persistence: () => persistence.web.sqlite({ name: "tasks" }),
  config: () => ({
    convexClient,
    api: api.tasks,
    getKey: (t) => t.id,
    user: () => identity.from({
      id: authSession.user.id,
      name: authSession.user.name,
      avatar: authSession.user.image,
    }),
  }),
});
```

Anonymous users automatically get stable generated names and colors.

---

## Presence & Sessions

### Client API

Presence is accessed through document context:

```typescript
const coll = tasks.get();
const doc = coll.doc("task-123");

// Join/leave
doc.presence.join();
doc.presence.join({ cursor: { x: 100, y: 200 } });
doc.presence.update({ cursor: { x: 150, y: 250 } });
doc.presence.leave();

// Current presence
const { local, remote } = doc.presence.get()

// Subscribe to changes
const unsub = doc.presence.subscribe(({ local, remote }) => {
  updateAvatars(remote);
});

// Low-level Yjs access
doc.awareness;  // Yjs Awareness instance
```

**Collection-level sessions:**

```typescript
coll.session.get();                // All active sessions
coll.session.get("task-123");      // Sessions for specific doc
coll.session.subscribe(cb);        // Subscribe to changes
```

### Server API

```typescript
// convex/tasks.ts
import { collection } from "@trestleinc/replicate/server";

export const {
  material,    // query: SSR hydration
  delta,       // query: real-time sync
  replicate,   // mutation: insert/update/remove
  presence,    // mutation: join/leave/heartbeat
  session,     // query: active sessions
} = collection.create<Task>(components.replicate, "tasks");
```

### API Matrix

| Export      | Type     | Auth                       | Purpose               |
| ----------- | -------- | -------------------------- | --------------------- |
| `material`  | query    | `view`                     | SSR hydration         |
| `delta`     | query    | `view`                     | Real-time sync stream |
| `session`   | query    | `view`                     | Who's online          |
| `presence`  | mutation | `view`                     | Join/leave/heartbeat  |
| `replicate` | mutation | `evalWrite` / `evalRemove` | Data sync             |

---

## Collaborative Editing

For rich text with presence:

```typescript
const doc = coll.doc("task-123");

const binding = await doc.prose("content", {
  user: identity.from({ id, name, color }),
  debounceMs: 200,
});

// Use with TipTap/ProseMirror
const editor = new Editor({
  extensions: [
    Collaboration.configure({ fragment: binding.fragment }),
    CollaborationCursor.configure({ provider: binding.provider }),
  ],
});

// Cleanup
binding.destroy();
```

---

## Authorization

### View Function

The `view` function controls **all read access**:

```typescript
collection.create<Task>(components.replicate, "tasks", {
  view: async (ctx, q) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    return q
      .withIndex("by_owner", q => q.eq("ownerId", identity.subject))
      .order("desc");
  },
});
```

If a user can't see a document via `view`, they also can't:

- Fetch it via `material`
- Sync it via `delta`
- See who's editing via `session`
- Join presence via `presence`

### Hooks

```typescript
collection.create<Task>(components.replicate, "tasks", {
  view: async (ctx, q) => { /* read gate */ },

  hooks: {
    // Authorization (throw to deny)
    evalWrite: async (ctx, doc) => { /* validate writes */ },
    evalRemove: async (ctx, docId) => { /* validate deletes */ },
    evalSession: async (ctx, client) => { /* validate presence */ },

    // Lifecycle (run after operation)
    onInsert: async (ctx, doc) => { /* after insert */ },
    onUpdate: async (ctx, doc) => { /* after update */ },
    onRemove: async (ctx, docId) => { /* after delete */ },

    // Transform (modify query results)
    transform: async (docs) => docs.filter(d => d.isPublic),
  },
});
```

### Authorization Patterns

**User-Owned Data:**

```typescript
collection.create<Task>(components.replicate, "tasks", {
  view: async (ctx, q) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    return q
      .withIndex("by_owner", q => q.eq("ownerId", identity.subject))
      .order("desc");
  },

  hooks: {
    evalWrite: async (ctx, doc) => {
      const identity = await ctx.auth.getUserIdentity();
      if (doc.ownerId !== identity?.subject) {
        throw new Error("Forbidden");
      }
    },
  },
});
```

**Multi-Tenant:**

```typescript
collection.create<Project>(components.replicate, "projects", {
  view: async (ctx, q) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.org_id) {
      throw new Error("Unauthorized: must belong to organization");
    }

    return q
      .withIndex("by_tenant", q => q.eq("tenantId", identity.org_id))
      .order("desc");
  },
});
```

---

## Encryption

### Modes

| Mode      | Local Storage | Server Storage                | Use Case          |
| --------- | ------------- | ----------------------------- | ----------------- |
| **None**  | Plaintext     | Plaintext + Convex encryption | Standard apps     |
| **Local** | Encrypted     | Plaintext + Convex encryption | Device protection |
| **E2E**   | Encrypted     | Encrypted blobs               | Maximum privacy   |

### Low-Level API

Direct control over encryption state:

```typescript
const encryption = await persistence.web.encryption({
  storage: await persistence.web.sqlite.once({ name: "app" }),
  user: userId,
  mode: "local",

  unlock: {
    webauthn: true,
    passphrase: {
      get: () => promptPassphrase(),
      setup: (recoveryKey) => promptSetup(recoveryKey),
    },
  },
});

const { state } = encryption.get()  // "locked" | "unlocked" | "setup"
encryption.lock()
encryption.unlock()
```

### Manager API

For per-user optional encryption with state management:

```typescript
const encryption = await persistence.web.encryption.manager({
  storage: await persistence.web.sqlite.once({ name: "app" }),
  user: userId,
  preference: "webauthn",

  hooks: {
    change: (state) => updateUI(state),
    passphrase: () => showPassphraseModal(),
    recovery: (key) => showRecoveryKey(key),
  },
});

// Get current state
const { state, error, persistence } = encryption.get()
// Actions
encryption.enable();     // User opts in → setup flow
encryption.disable();    // User opts out
encryption.unlock();     // Unlock (prompts via hooks)
encryption.lock();       // Lock immediately

// Lifecycle
encryption.subscribe(cb);
encryption.destroy();
```

**Integration with presence:**
When encryption locks, presence automatically leaves all documents.

### Feature Detection

```typescript
persistence.web.encryption.webauthn.supported()   // WebAuthn PRF available
persistence.native.encryption.biometric.supported() // Biometrics available
```

### React Native

```typescript
const encryption = await persistence.native.encryption.manager({
  storage: await persistence.native.sqlite({ name: "app" }),
  user: userId,
  preference: "biometric",

  hooks: {
    change: (state) => {},
    passphrase: () => {},
    recovery: (key) => {},
  },
});
```

---

## Schema

Replicate uses consistent singular naming for all tables:

```typescript
// Sync tables
delta: {
  collection, document, bytes, seq
}

snapshot: {
  collection, document, bytes, vector, seq, created
}

session: {
  collection, document, client, user, profile, cursor,
  vector, seq, connected, seen, timeout
}

// E2E encryption tables
device: {
  collection, client, user, name, publicKey, approved, created, seen
}

key: {
  collection, client, user, umk, created
}

grant: {
  collection, document, user, key, created
}
```

**Field naming conventions:**

- `client` - unique browser/device ID (UUID per tab)
- `user` - authenticated user ID (shared across devices)
- `seen` - last activity timestamp
- `created` - creation timestamp

---

## How Encryption Works

### WebAuthn PRF (Biometrics)

```
Touch ID / Face ID / Windows Hello
        |
        v
   WebAuthn + PRF Extension
        |
        v
   Deterministic 256-bit secret
        |
        v
   Encryption key (same biometric = same key)
```

**Browser Support:**

- Chrome 132+, Edge 132+
- Safari macOS 15+ / iOS 18+
- Firefox 135+

### Key Hierarchy

```
LEVEL 1: Device Keys (per device)
  Biometric --> WebAuthn PRF --> Device Key

LEVEL 2: User Master Key (per user)
  UMK (random 256-bit)
    |-- Wrapped for iPhone
    |-- Wrapped for MacBook
    |-- Wrapped for Android

LEVEL 3: Document Keys (for sharing)
  Doc Key (random 256-bit)
    |-- Wrapped for Alice's UMK
    |-- Wrapped for Bob's UMK
```

### Device Approval Flow

```
1. User signs in on new device (OAuth)
2. New device: Biometric --> new Device Key
3. New device registers public key with server
4. Existing device shows: "New device wants access"
5. User approves with biometric on existing device
6. Existing device wraps UMK with new device's public key
7. New device downloads wrapped UMK, unwraps with biometric
8. New device has full access
```

---

## Complete Example

```typescript
// src/lib/identity.ts
import { identity } from "@trestleinc/replicate/client";
import { authClient } from "./auth";

export function getUser() {
  const session = authClient.getSession();
  if (!session?.user) return undefined;

  return identity.from({
    id: session.user.id,
    name: session.user.name,
    avatar: session.user.image,
  });
}

// src/lib/encryption.ts
import { persistence } from "@trestleinc/replicate/client";
import { getUser } from "./identity";

export async function createEncryption() {
  const user = getUser();
  if (!user) throw new Error("Not authenticated");

  return persistence.web.encryption.manager({
    storage: await persistence.web.sqlite.once({ name: "app" }),
    user: user.id,
    preference: "webauthn",

    hooks: {
      change: (state) => encryptionStore.set({ state }),
      passphrase: () => showPassphraseModal(),
      recovery: (key) => showRecoveryModal(key),
    },
  });
}

// src/collections/tasks.ts
import { collection, persistence } from "@trestleinc/replicate/client";
import { getUser } from "../lib/identity";
import { encryptionStore } from "../lib/encryption";

export const tasks = collection.create(schema, "tasks", {
  persistence: () => {
    const encryption = encryptionStore.get();
    const { persistence } = encryption.get();
    return persistence;
  },

  config: () => ({
    convexClient,
    api: api.tasks,
    getKey: (t) => t.id,
    user: getUser,
  }),
});

// src/components/TaskEditor.tsx
function TaskEditor({ taskId }: { taskId: string }) {
  const coll = tasks.get();
  const doc = coll.doc(taskId);
  const [remote, setRemote] = useState([]);
  const [binding, setBinding] = useState(null);

  useEffect(() => {
    doc.presence.join();
    const unsub = doc.presence.subscribe(({ remote }) => setRemote(remote));
    return () => {
      unsub();
      doc.presence.leave();
    };
  }, [taskId]);

  useEffect(() => {
    let b = null;
    doc.prose("description").then((binding) => {
      b = binding;
      setBinding(binding);
    });
    return () => b?.destroy();
  }, [taskId]);

  return (
    <div>
      <div className="flex gap-2">
        {remote.map((u) => (
          <Avatar key={u.client} src={u.avatar} name={u.name} color={u.color} />
        ))}
      </div>

      {binding && (
        <TipTapEditor fragment={binding.fragment} provider={binding.provider} />
      )}
    </div>
  );
}
```

---

## Security Summary

| Property             | Local Mode | E2E Mode |
| -------------------- | ---------- | -------- |
| Local data encrypted | Yes        | Yes      |
| Offline access       | Yes        | Yes      |
| Multi-user isolation | Yes        | Yes      |
| Server can read data | Yes        | **No**   |
| Server-side queries  | Yes        | **No**   |
| Passwordless         | Yes        | Yes      |
| Multi-device         | Yes        | Yes      |

| Concern            | Handled By              | Works Offline? |
| ------------------ | ----------------------- | -------------- |
| Who are you?       | Auth Provider           | No             |
| What can you see?  | `view` function         | No             |
| What can you edit? | `evalWrite` hook        | No             |
| Can you decrypt?   | Biometrics / Passphrase | **Yes**        |

---

## Auth Provider Setup

Replicate uses a pre-authenticated ConvexClient:

**Better Auth (SvelteKit):**

```typescript
import { createSvelteAuthClient } from "@mmailaender/convex-better-auth-svelte/svelte";
createSvelteAuthClient({ authClient, convexClient });
```

**Clerk (React):**

```typescript
<ClerkProvider>
  <ConvexProviderWithClerk client={convexClient} useAuth={useAuth}>
    <App />
  </ConvexProviderWithClerk>
</ClerkProvider>
```

**Custom:**

```typescript
convexClient.setAuth(async ({ forceRefreshToken }) => {
  const token = await authProvider.getToken({ skipCache: forceRefreshToken });
  return token ?? null;
});
```
