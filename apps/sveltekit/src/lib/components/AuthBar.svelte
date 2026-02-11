<script lang="ts">
	import { getAuthClient } from '$lib/auth-client';
	import { useAuth } from '@mmailaender/convex-better-auth-svelte/svelte';
	import { Button } from '$lib/components/ui/button';
	import SignInDialog from './SignInDialog.svelte';

	const auth = useAuth();
	const isAuthenticated = $derived(auth.isAuthenticated);

	// Session state - use $effect for subscription (Svelte 5 pattern)
	let sessionData = $state<{ user?: { email: string } } | null>(null);
	let showSignIn = $state(false);

	// PERFORMANCE FIX: Use $effect with cleanup instead of onMount
	$effect(() => {
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
		<span class="text-muted-foreground max-w-[140px] truncate font-mono text-xs">
			{sessionData.user.email}
		</span>
		<Button variant="ghost" size="xs" onclick={handleSignOut}>Sign Out</Button>
	{:else}
		<Button variant="outline" size="xs" onclick={() => (showSignIn = true)}>Sign In</Button>
	{/if}
</div>

<SignInDialog bind:open={showSignIn} />
