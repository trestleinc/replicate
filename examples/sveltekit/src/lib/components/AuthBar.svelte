<script lang="ts">
  import { onMount } from "svelte";
  import { getAuthClient } from "$lib/auth-client";
  import { useAuth } from "@mmailaender/convex-better-auth-svelte/svelte";
  import { Button } from "$lib/components/ui/button";
  import SignInDialog from "./SignInDialog.svelte";

  const auth = useAuth();
  const isAuthenticated = $derived(auth.isAuthenticated);

  // Session state - updated from auth client on mount
  let sessionData = $state<{ user?: { email: string } } | null>(null);
  let showSignIn = $state(false);

  onMount(() => {
    const authClient = getAuthClient();
    const session = authClient.useSession();
    const unsubscribe = session.subscribe((s) => {
      sessionData = s.data;
    });
    return unsubscribe;
  });

  async function handleSignOut() {
    const authClient = getAuthClient();
    await authClient.signOut();
  }
</script>

<div class="flex items-center gap-2">
  {#if isAuthenticated && sessionData?.user}
    <span class="text-sm text-muted-foreground">
      {sessionData.user.email}
    </span>
    <Button variant="ghost" size="sm" onclick={handleSignOut}>
      Sign Out
    </Button>
  {:else}
    <Button variant="ghost" size="sm" onclick={() => showSignIn = true}>
      Sign In
    </Button>
  {/if}
</div>

<SignInDialog bind:open={showSignIn} />
