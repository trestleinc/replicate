<script lang="ts">
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import { useLiveQuery } from "@tanstack/svelte-db";
  import { Plus, Search, SlidersHorizontal, Globe, Lock } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import StatusIcon from "./StatusIcon.svelte";
  import StarIcon from "./StarIcon.svelte";
  import AuthBar from "./AuthBar.svelte";
  import { intervals as intervalsCollection, type Interval } from "$collections/useIntervals";
  import { schema } from "@trestleinc/replicate/client";
  import { getAuthClient } from "$lib/auth-client";
  import { useAuth } from "@mmailaender/convex-better-auth-svelte/svelte";

  interface Props {
    onsearchopen?: () => void;
    onfilteropen?: () => void;
    hasActiveFilters?: boolean;
  }

  const { onsearchopen, onfilteropen, hasActiveFilters = false }: Props = $props();

  const auth = useAuth();
  const isAuthenticated = $derived(auth.isAuthenticated);

  // Session state - updated from auth client on mount
  let sessionData = $state<{ user?: { id: string } } | null>(null);
  const collection = intervalsCollection.get();

  onMount(() => {
    const authClient = getAuthClient();
    const session = authClient.useSession();
    // Subscribe to session changes
    const unsubscribe = session.subscribe((s) => {
      sessionData = s.data;
    });
    return unsubscribe;
  });
  const intervalsQuery = useLiveQuery(collection);

  let editingId = $state<string | null>(null);
  let editTitle = $state("");

  const intervals = $derived((intervalsQuery.data ?? []));
  const sortedIntervals = $derived(
    [...intervals]
      .filter((i): i is Interval => typeof i.id === "string" && i.id.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt),
  );

  const activeId = $derived(page.params.id);

  function createInterval(isPublic: boolean = true) {
    const id = crypto.randomUUID();
    const now = Date.now();
    const user = sessionData?.user;
    collection.insert({
      id,
      ownerId: user?.id,
      isPublic,
      title: "New Interval",
      description: schema.prose.empty(),
      status: "backlog",
      priority: "none",
      createdAt: now,
      updatedAt: now,
    });
  }

  function startRename(id: string) {
    const interval = intervals.find(i => i.id === id);
    if (interval) {
      editingId = id;
      editTitle = interval.title;
    }
  }

  function saveRename(id: string) {
    if (editTitle.trim()) {
      collection.update(id, (draft) => {
        draft.title = editTitle.trim();
        draft.updatedAt = Date.now();
      });
    }
    editingId = null;
  }

  function handleKeydown(e: KeyboardEvent, id: string) {
    if (e.key === "Enter") saveRename(id);
    if (e.key === "Escape") editingId = null;
  }
</script>

<aside
  class="hidden md:flex w-[var(--sidebar-width)] min-w-[var(--sidebar-width)] h-dvh flex-col bg-sidebar overflow-hidden"
>
  <div class="flex items-center justify-between px-3 py-3 border-b border-sidebar-border">
    <a
      href="/intervals"
      class="flex items-center gap-2 font-display text-base font-normal text-sidebar-foreground no-underline"
    >
      <StarIcon size={18} />
      <span>Interval</span>
    </a>
    <div class="flex items-center gap-1">
      <Button variant="ghost" size="icon-sm" onclick={onsearchopen} aria-label="Search intervals">
        <Search class="w-4 h-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onclick={onfilteropen}
        aria-label="Filter intervals"
        class={hasActiveFilters ? "text-primary" : ""}
      >
        <SlidersHorizontal class="w-4 h-4" />
      </Button>
    </div>
  </div>

  <div class="p-2 space-y-1">
    <Button variant="outline" class="w-full justify-start gap-2" onclick={() => createInterval(true)}>
      <Globe class="w-4 h-4" />
      <span>New Public</span>
    </Button>
    {#if sessionData?.user}
      <Button variant="outline" class="w-full justify-start gap-2" onclick={() => createInterval(false)}>
        <Lock class="w-4 h-4" />
        <span>New Private</span>
      </Button>
    {/if}
  </div>

  <div class="flex-1 overflow-auto">
    {#if intervalsQuery.isLoading}
      <div class="space-y-2 p-2">
        <div class="h-8 w-full bg-muted animate-pulse rounded"></div>
        <div class="h-8 w-3/4 bg-muted animate-pulse rounded"></div>
        <div class="h-8 w-4/5 bg-muted animate-pulse rounded"></div>
      </div>
    {:else if sortedIntervals.length === 0}
      <div class="flex flex-col items-center justify-center py-8 px-3 text-muted-foreground text-center text-sm">
        <StatusIcon status="backlog" size={24} class="mb-2 opacity-30" />
        <p class="m-0">No intervals yet</p>
        <p class="m-0 text-xs opacity-60">Create your first interval</p>
      </div>
    {:else}
      <nav class="p-1">
        <ul class="list-none m-0 p-0">
          {#each sortedIntervals as interval (interval.id)}
            <li>
              {#if editingId === interval.id}
                <div class="flex items-center gap-2 px-3 py-2 bg-muted">
                  <StatusIcon status={interval.status} size={14} class="shrink-0" />
                  <Input
                    type="text"
                    bind:value={editTitle}
                    onblur={() => saveRename(interval.id)}
                    onkeydown={e => handleKeydown(e, interval.id)}
                    class="flex-1 h-6 text-sm p-1"
                  />
                </div>
              {:else}
                <a
                  href="/intervals/{interval.id}"
                  class="group flex items-center gap-2 px-3 py-2 text-sm no-underline transition-colors {activeId === interval.id
                    ? 'bg-muted text-foreground border-l-2 border-sidebar-accent'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground border-l-2 border-transparent'}"
                >
                  <StatusIcon status={interval.status} size={14} class="shrink-0" />
                  <button
                    type="button"
                    class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left bg-transparent border-none p-0 font-inherit text-inherit cursor-pointer"
                    ondblclick={() => startRename(interval.id)}
                  >
                    {interval.title || "Untitled"}
                  </button>
                  {#if interval.isPublic}
                    <Globe class="w-3 h-3 text-muted-foreground/50 shrink-0" />
                  {:else}
                    <Lock class="w-3 h-3 text-muted-foreground/50 shrink-0" />
                  {/if}
                </a>
              {/if}
            </li>
          {/each}
        </ul>
      </nav>
    {/if}
  </div>

  <div class="border-t border-sidebar-border p-3">
    <AuthBar />
  </div>
</aside>
