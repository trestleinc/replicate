# Authentication & Authorization

This guide explains how to secure your Replicate collections.

## Overview

Replicate uses a layered security model:

```
view       = read access gate (documents, sync, presence)
hooks      = write access gate + lifecycle events
encryption = data protection (local + optional E2E)
```

**Key insight**: Authentication (who you are) is separate from encryption (protecting data). This enables:
- Any auth provider (Clerk, WorkOS, Google OAuth, Better Auth)
- Passwordless encryption via biometrics (Touch ID / Face ID)
- Offline access to encrypted data

## Authorization

### View Function

The `view` function controls **all read access**. If a user can't see a document via `view`, they also can't:
- Fetch it via `material`
- Sync it via `delta`
- See who's editing it via `session`
- Join presence for it via `presence`

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
    evalWrite: async (ctx, doc) => { /* validate writes */ },
    evalRemove: async (ctx, docId) => { /* validate deletes */ },
  },
});
```

### API Auth Matrix

| API | Type | Auth | Purpose |
|-----|------|------|---------|
| `material` | query | `view` | SSR hydration, paginated docs |
| `delta` | query | `view` | Real-time sync stream |
| `session` | query | `view` | Who's online (user-level) |
| `presence` | mutation | `view` | Join/leave/heartbeat |
| `replicate` | mutation | `evalWrite` / `evalRemove` | Insert/update/delete |

### Hooks

Hooks provide write-side authorization and lifecycle events:

```typescript
hooks: {
  // Write authorization (throw to deny)
  evalWrite?: (ctx: MutationCtx, doc: T) => void | Promise<void>;
  evalRemove?: (ctx: MutationCtx, docId: string) => void | Promise<void>;
  evalSession?: (ctx: MutationCtx, client: string) => void | Promise<void>;
  
  // Lifecycle events (run after operation)
  onInsert?: (ctx: MutationCtx, doc: T) => void | Promise<void>;
  onUpdate?: (ctx: MutationCtx, doc: T) => void | Promise<void>;
  onRemove?: (ctx: MutationCtx, docId: string) => void | Promise<void>;
  
  // Field-level transform (runs on query results)
  transform?: (docs: T[]) => T[] | Promise<T[]>;
}
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

**Role-Based:**
```typescript
collection.create<Document>(components.replicate, "documents", {
  view: async (ctx, q) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");
    
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", q => q.eq("tokenIdentifier", identity.subject))
      .unique();
    
    if (user?.role === "admin") {
      return q.withIndex("by_timestamp").order("desc");
    }
    
    return q
      .withIndex("by_owner", q => q.eq("ownerId", identity.subject))
      .order("desc");
  },
});
```

---

## Encryption

Replicate supports optional encryption for local storage, with an additional opt-in for end-to-end encryption where the server cannot read your data.

### Security Layers

```
SERVER LAYER                              CLIENT LAYER
view: (ctx, q) => ...                     persistence.web.encrypted({ ... })
- WHO can see what docs                   - HOW data is protected
- Applied at query time                   - Local encryption + optional E2E
- Auth-dependent (online)                 - Works offline
```

### Encryption Modes

| Mode | Local Storage | Server Storage | Use Case | Status |
|------|--------------|----------------|----------|--------|
| **None** (default) | Plaintext | Plaintext + Convex encryption | Standard apps | ✅ Available |
| **Local** | Encrypted | Plaintext + Convex encryption | Device protection | ✅ Available |
| **E2E** | Encrypted | Encrypted blobs (server can't read) | Maximum privacy | 🚧 Planned |

> **Note:** Local encryption mode is fully implemented. E2E mode (server-side encrypted blobs) is planned for a future release.

### API

```typescript
// Web (uses WebAuthn PRF for biometrics)
persistence.web.encrypted({
  storage: persistence.web.sqlite(db, name),
  userId,
  mode?: 'local' | 'e2e',  // default: 'local'
  
  unlock: {
    webauthn?: true,
    passphrase?: {
      get: () => Promise<string>,
      setup: (recoveryKey: string) => Promise<string>,
    },
  },
  
  recovery?: {
    onSetup: (key: string) => Promise<void>,
    onRecover: () => Promise<string>,
  },
  
  lock?: { idle: number },
  onLock?: () => void,
  onUnlock?: () => void,
})

// Native (uses react-native-keychain / expo biometrics)
persistence.native.encrypted({
  storage: persistence.native.sqlite(db, name),
  userId,
  mode?: 'local' | 'e2e',
  
  unlock: {
    biometric?: true,
    passphrase?: {
      get: () => Promise<string>,
      setup: (recoveryKey: string) => Promise<string>,
    },
  },
  
  // same options as web...
})

// Cross-platform (no encryption)
persistence.memory()
persistence.custom(adapter)
```

### Basic Usage

**Local encryption with biometrics (simplest):**
```typescript
export const tasks = collection.create(schema, "tasks", {
  persistence: async () => {
    const userId = authStore.user?.id;
    if (!userId) throw new Error("Not authenticated");

    const db = await getDatabase();
    return persistence.web.encrypted({
      storage: persistence.web.sqlite(db, "tasks"),
      userId,
      unlock: { webauthn: true },
    });
  },
  config: () => ({ convexClient, api: api.tasks, getKey: (t) => t.id }),
});
```

**E2E encryption with biometrics:**
```typescript
persistence.web.encrypted({
  storage: persistence.web.sqlite(db, "tasks"),
  userId,
  mode: 'e2e',
  unlock: { webauthn: true },
})
```

**With passphrase fallback:**
```typescript
persistence.web.encrypted({
  storage: persistence.web.sqlite(db, "tasks"),
  userId,
  mode: 'e2e',
  unlock: {
    webauthn: true,
    passphrase: {
      get: () => showUnlockDialog(),
      setup: (recoveryKey) => showSetupDialog(recoveryKey),
    },
  },
})
```

**With recovery + auto-lock:**
```typescript
persistence.web.encrypted({
  storage: persistence.web.sqlite(db, "tasks"),
  userId,
  mode: 'e2e',
  unlock: {
    webauthn: true,
    passphrase: {
      get: () => showUnlockDialog(),
      setup: (recoveryKey) => showSetupDialog(recoveryKey),
    },
  },
  recovery: {
    onSetup: (key) => showRecoveryKeyDialog(key),
    onRecover: () => promptRecoveryKeyInput(),
  },
  lock: { idle: 5 },
  onLock: () => navigate('/locked'),
})
```

**React Native:**
```typescript
persistence.native.encrypted({
  storage: persistence.native.sqlite(db, "tasks"),
  userId,
  unlock: { biometric: true },
})
```

---

## How It Works

### WebAuthn PRF (Biometrics)

WebAuthn PRF enables **passwordless encryption** using Touch ID, Face ID, or Windows Hello.

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

**Browser Support (all major browsers):**
- Chrome 132+
- Edge 132+
- Safari macOS 15+ / iOS 18+
- Firefox 135+

**Auto-detection:** When `webauthn: true`, Replicate automatically selects the best available authenticator (Touch ID → Face ID → Windows Hello → security key).

**Passphrase fallback** is optional - useful for user preference or recovery on new devices.

### Key Hierarchy (Apple-Style)

Replicate uses the same key hierarchy as Apple iCloud Keychain:

```
LEVEL 1: Device Keys (per device)
  Touch ID --> WebAuthn PRF --> Device Key
  
LEVEL 2: User Master Key (per user, shared across devices)
  UMK (random 256-bit)
    |-- Wrapped with iPhone's device key
    |-- Wrapped with MacBook's device key
    |-- Wrapped with Android's device key
  
LEVEL 3: Document Keys (per document, for sharing)
  Doc Key (random 256-bit)
    |-- Wrapped with Alice's UMK
    |-- Wrapped with Bob's UMK (if shared)
```

**Decryption path:**
```
Biometric --> Device Key --> unwrap UMK --> unwrap Doc Key --> decrypt data
```

### Device Approval Flow

When adding a new device (no passwords required):

```
1. User signs in on new MacBook (OAuth)
2. MacBook: Touch ID --> new Device Key
3. MacBook registers public key with server
4. iPhone shows: "New device wants access - MacBook Pro"
5. User approves with Face ID on iPhone
6. iPhone wraps UMK with MacBook's public key, uploads
7. MacBook downloads wrapped UMK, unwraps with Touch ID
8. MacBook now has full access
```

### What Server Stores

```typescript
// Per user
{
  userId: "alice",
  devices: [
    { deviceId: "iphone", publicKey: "..." },
    { deviceId: "macbook", publicKey: "..." },
  ],
  wrappedUMK: [
    { deviceId: "iphone", wrapped: "..." },
    { deviceId: "macbook", wrapped: "..." },
  ],
}

// Per document (E2E mode)
{
  docId: "doc123",
  encryptedContent: "...",  // Server can't read
  wrappedDocKey: [
    { userId: "alice", wrapped: "..." },
    { userId: "bob", wrapped: "..." },
  ],
}
```

### E2E Encryption Flow

```
CLIENT                                    SERVER

User edits document
        |
        v
Yjs CRDT update (plaintext)
        |
        +---> Encrypt with Doc Key
        |            |
        v            v
Store in SQLite     Send encrypted blob ---------> Store encrypted
(encrypted)                                        (can't decrypt)


SYNC FROM SERVER:

<------------------------------------ Receive encrypted blob
        |
        v
Decrypt with Doc Key
        |
        v
Apply Yjs update
        |
        v
Re-encrypt for local storage
```

---

## User Flows

### First Time Setup (Biometrics)

```
+------------------------------------------+
|  Secure Your Data                        |
|                                          |
|  Use Touch ID to encrypt your data.      |
|  This works offline and keeps your       |
|  data private.                           |
|                                          |
|  [Enable Touch ID]                       |
+------------------------------------------+
```

If recovery is configured:
```
+------------------------------------------+
|  Your Recovery Key                       |
|                                          |
|  A3X7-K9M2-P4Q8-R1T5-W6Y0-B2C8          |
|                                          |
|  Save this! It's the only way to         |
|  access your data on a new device.       |
|                                          |
|  [Copy] [I've Saved It]                  |
+------------------------------------------+
```

### Returning User (Unlock)

```
+------------------------------------------+
|  Unlock Your Data                        |
|                                          |
|  [Use Touch ID]                          |
|                                          |
|  [Use Passphrase Instead]                |
+------------------------------------------+
```

### New Device

```
+------------------------------------------+
|  Set Up This Device                      |
|                                          |
|  Approve from another device, or         |
|  enter your recovery key.                |
|                                          |
|  [Request Approval]                      |
|  [Use Recovery Key]                      |
+------------------------------------------+
```

---

## Complete Example

```typescript
// src/collections/tasks.ts
import { collection, persistence } from "@trestleinc/replicate/client";
import { authStore } from "$lib/auth";
import { getDatabase } from "$lib/db";
import { 
  showUnlockDialog, 
  showSetupDialog, 
  showRecoveryKeyDialog,
  showRecoveryInput 
} from "$lib/dialogs";

export const tasks = collection.create(schema, "tasks", {
  persistence: async () => {
    const userId = authStore.user?.id;
    if (!userId) throw new Error("Not authenticated");

    const db = await getDatabase();
    return persistence.web.encrypted({
      storage: persistence.web.sqlite(db, "tasks"),
      userId,
      mode: 'e2e',
      
      unlock: {
        webauthn: true,
        passphrase: {
          get: () => showUnlockDialog(),
          setup: (recoveryKey) => showSetupDialog(recoveryKey),
        },
      },
      
      recovery: {
        onSetup: (key) => showRecoveryKeyDialog(key),
        onRecover: () => showRecoveryInput(),
      },
      
      lock: { idle: 5 },
      onLock: () => navigate('/locked'),
    });
  },
  
  config: () => ({
    convexClient,
    api: api.tasks,
    getKey: (t) => t.id,
    user: () => authStore.user,
  }),
});
```

---

## Security Summary

| Property | Local Mode | E2E Mode |
|----------|------------|----------|
| Data encrypted at rest (local) | Yes | Yes |
| Offline access | Yes | Yes |
| Multi-user isolation | Yes | Yes |
| Server can read data | Yes | **No** |
| Server-side queries | Yes | **No** |
| Passwordless (biometrics) | Yes | Yes |
| Multi-device | Yes | Yes (device approval) |

| Concern | Handled By | Works Offline? |
|---------|------------|----------------|
| "Who are you?" | Auth Provider | No |
| "Can you see this doc?" | `view` function | No |
| "Can you edit this doc?" | `evalWrite` hook | No |
| "Can you decrypt data?" | Biometrics / Passphrase | **Yes** |

---

## Client-Side Auth Setup

Replicate uses a **pre-authenticated ConvexClient**. Your auth provider configures the client, Replicate reuses it.

```typescript
// src/lib/convex.ts
import { ConvexClient } from "convex/browser";
export const convexClient = new ConvexClient(process.env.PUBLIC_CONVEX_URL);
```

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
convexClient.setAuth(
  async ({ forceRefreshToken }) => {
    const token = await yourAuthProvider.getToken({ skipCache: forceRefreshToken });
    return token ?? null;
  }
);
```

---

## Presence Identity

Presence (cursors, avatars) uses a separate client-side identity that works with any auth provider:

```typescript
export const tasks = collection.create(schema, "tasks", {
  persistence: () => persistence.web.sqlite(db, "tasks"),
  config: () => ({
    convexClient,
    api: api.tasks,
    getKey: (t) => t.id,
    
    user: () => {
      const session = getAuthSession();
      if (!session?.user) return undefined;
      
      return {
        id: session.user.id,
        name: session.user.name,
        avatar: session.user.image,
      };
    },
  }),
});
```

Anonymous users get auto-generated names and colors.
