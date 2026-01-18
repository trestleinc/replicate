# Expo Example - Interval Tracker

Offline-first interval tracking app for React Native using Replicate with native SQLite persistence.

## What This Demonstrates

- Native SQLite persistence using `op-sqlite` instead of sql.js WASM
- Plain text editing with `useProseField` hook for Y.XmlFragment binding
- Crypto polyfill setup required for React Native (`react-native-get-random-values`)
- Metro bundler configuration for Yjs/lib0 deduplication
- Collection initialization pattern with `PersistenceGate` component

## Prerequisites: Native Modules

This example uses native modules that require a **development build** (not Expo Go):

- **`@op-engineering/op-sqlite`** - Native SQLite bindings
- **`react-native-get-random-values`** - Crypto polyfill with native RNG
- **`react-native-random-uuid`** - UUID generation

You must run `expo prebuild` to generate the native `ios/` and `android/` directories before building.

## Quick Start

```bash
# Install dependencies
bun install

# Set up environment
cp .env.example .env.local
# Add your EXPO_PUBLIC_CONVEX_URL

# Generate native projects (required for native modules)
bun run prebuild

# Deploy Convex functions
bunx convex dev

# Run on iOS (requires Xcode)
bun run ios

# Run on Android (requires Android Studio)
bun run android
```

> **Note:** You cannot use Expo Go with this example. The native modules require a custom dev client built via `expo run:ios` or `expo run:android`.

## Key Implementation Files

| File                                | Purpose                                                   |
| ----------------------------------- | --------------------------------------------------------- |
| `src/collections/useIntervals.ts`   | Native SQLite setup with `persistence.sqlite.native()`    |
| `src/hooks/useProseField.ts`        | Y.XmlFragment to TextInput binding with debounced sync    |
| `src/contexts/IntervalsContext.tsx` | Collection initialization with `PersistenceGate` pattern  |
| `app/_layout.tsx`                   | Crypto polyfill imports (must be first)                   |
| `metro.config.js`                   | Yjs/lib0 deduplication to prevent duplicate module errors |
| `src/types/interval.ts`             | Zod schema with `prose()` field type                      |

## The useProseField Pattern

React Native lacks ProseMirror/TipTap support, so this example uses a custom `useProseField` hook that:

1. Binds a Y.XmlFragment to a plain `TextInput`
2. Converts Y.XmlFragment to/from plain text on the fly
3. Debounces updates (1 second) to avoid excessive CRDT operations
4. Observes remote changes and updates the TextInput

```typescript
// Usage in a component
const { text, isReady, handleChangeText } = useProseField(intervalId);

<TextInput
  value={text}
  onChangeText={handleChangeText}
  editable={isReady}
/>
```

This approach sacrifices rich text formatting but maintains full CRDT sync compatibility with web clients using TipTap.

## Differences from Web Examples

| Aspect      | Web (TanStack Start/SvelteKit)       | React Native (Expo)                       |
| ----------- | ------------------------------------ | ----------------------------------------- |
| Persistence | `sql.js` WASM + OPFS                 | `op-sqlite` (native SQLite)               |
| Rich Text   | TipTap editor with ProseMirror       | Plain TextInput + `useProseField`         |
| Crypto      | Browser native                       | `react-native-get-random-values` polyfill |
| Bundler     | Vite                                 | Metro with yjs/lib0 deduplication         |
| SSR         | Server-side hydration via `material` | N/A - client-only                         |

## Native SQLite Setup

```typescript
// src/collections/useIntervals.ts
import { collection, persistence } from "@trestleinc/replicate/client";
import { open } from "@op-engineering/op-sqlite";

export const intervals = collection.create({
  persistence: async () => {
    const db = open({ name: "intervals.db" });
    return persistence.sqlite.native(db, "intervals");
  },
  config: () => ({ /* ... */ }),
});
```

## Metro Configuration

The `metro.config.js` forces single copies of `yjs` and `lib0` to prevent duplicate import errors that occur when dependencies bundle their own copies:

```javascript
// Force single copies of yjs and lib0
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "yjs") {
    return {
      filePath: path.resolve(projectRoot, "node_modules/yjs/dist/yjs.mjs"),
      type: "sourceFile",
    };
  }
  // Similar handling for lib0...
};
```

## Crypto Polyfill

React Native requires crypto polyfills for Yjs. Import at the very top of `app/_layout.tsx`:

```typescript
// Must be first imports!
import "react-native-get-random-values";
import "react-native-random-uuid";

// Then other imports...
```

## Documentation

See the [main README](../../README.md) for full Replicate documentation, including:

- Architecture and data flow
- Server-side schema and replication setup
- API reference
- Sync protocol details
