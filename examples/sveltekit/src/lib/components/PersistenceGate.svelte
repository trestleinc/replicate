<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { browser } from "$app/environment";
  import { intervals, type Interval } from "$collections/useIntervals";
  import { comments, type Comment } from "$collections/useComments";
  import type { Materialized, PaginatedMaterial } from "@trestleinc/replicate/client";
  import { encryptionStore, type EncryptionState } from "$lib/encryption";
  import EncryptionDialog from "./EncryptionDialog.svelte";
  import { Button } from "$lib/components/ui/button";
  import { getAuthClient } from "$lib/auth-client";

  let {
    children,
    intervalsMaterial,
    commentsMaterial,
    enableEncryption = false,
  }: {
    children: Snippet;
    intervalsMaterial?: PaginatedMaterial<Interval>;
    commentsMaterial?: Materialized<Comment>;
    enableEncryption?: boolean;
  } = $props();

  let ready = $state(false);
  let localError = $state<string | null>(null);
  let encryptionState: EncryptionState = $derived($encryptionStore.state);

  const encState = encryptionStore.state;
  const storeError = encryptionStore.error;
  let displayError = $derived($storeError ?? localError);

  async function initializeCollections() {
    try {
      await Promise.all([
        intervals.init(intervalsMaterial),
        comments.init(commentsMaterial),
      ]);
      ready = true;
    }
    catch (err) {
      localError = err instanceof Error ? err.message : "Unknown error";
    }
  }

  async function initWithEncryption() {
    try {
      const persistence = await encryptionStore.initialize(true);
      if (persistence && encryptionStore.getPersistence()) {
        const state = $encState;
        if (state === "unlocked" || state === "disabled" || state === "unsupported") {
          await initializeCollections();
        }
      }
    }
    catch (err) {
      localError = err instanceof Error ? err.message : "Encryption initialization failed";
    }
  }

  onMount(async () => {
    if (!browser) return;

    if (!enableEncryption) {
      await initializeCollections();
      return;
    }

    const authClient = getAuthClient();
    const session = authClient.useSession();
    const unsub = session.subscribe((s) => {
      if (s.isPending) return;

      unsub();

      if (!s.data?.user) {
        void initializeCollections();
        return;
      }

      void initWithEncryption();
    });
  });

  $effect(() => {
    if (enableEncryption && ($encState === "unlocked") && !ready && !displayError) {
      void initializeCollections();
    }
  });

  async function handleUnlock() {
    localError = null;
    const success = await encryptionStore.unlock();
    if (!success && !$storeError) {
      localError = "Failed to unlock";
    }
  }
</script>

{#if enableEncryption}
  <EncryptionDialog />
{/if}

{#if ready}
  {@render children()}
{:else if displayError}
  <div class="flex items-center justify-center h-screen">
    <div class="text-center max-w-md px-4">
      <div class="mb-4">
        <svg
          class="w-12 h-12 mx-auto text-destructive"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732
               4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      </div>
      <p class="text-destructive mb-4">{displayError}</p>
      <Button variant="outline" onclick={() => location.reload()}>Retry</Button>
    </div>
  </div>
{:else if enableEncryption && encryptionState === "locked"}
  <div class="flex items-center justify-center h-screen">
    <div class="text-center max-w-md px-4">
      <div class="mb-4">
        <svg
          class="w-16 h-16 mx-auto text-muted-foreground"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.5"
            d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2
               2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
          />
        </svg>
      </div>
      <h2 class="text-xl font-semibold mb-2">Data Encrypted</h2>
      <p class="text-muted-foreground mb-6">Your data is encrypted. Unlock to continue.</p>
      <Button onclick={handleUnlock} class="min-w-[120px]">
        Unlock
      </Button>
    </div>
  </div>
{:else if enableEncryption && encryptionState === "setup"}
  <div class="flex items-center justify-center h-screen">
    <div class="text-center max-w-md px-4">
      <div class="mb-4">
        <svg
          class="w-16 h-16 mx-auto text-muted-foreground"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.5"
            d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955
               11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824
               10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
          />
        </svg>
      </div>
      <h2 class="text-xl font-semibold mb-2">Set Up Encryption</h2>
      <p class="text-muted-foreground mb-6">Protect your data with end-to-end encryption.</p>
      <Button onclick={handleUnlock} class="min-w-[120px]">
        Set Up
      </Button>
    </div>
  </div>
{:else}
  <div class="flex items-center justify-center h-screen">
    <div class="text-center">
      <div
        class="animate-spin w-8 h-8 border-2 border-muted-foreground
               border-t-transparent rounded-full mx-auto mb-4"
      ></div>
      <p class="text-muted-foreground">Loading...</p>
    </div>
  </div>
{/if}
