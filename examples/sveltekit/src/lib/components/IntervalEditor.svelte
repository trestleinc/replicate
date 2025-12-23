<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { browser } from "$app/environment";
  import type { Editor } from "@tiptap/core";
  import type { EditorBinding } from "@trestleinc/replicate/client";
  import type { Interval, StatusValue, PriorityValue } from "$lib/types";
  import { Status, Priority, StatusLabels, PriorityLabels } from "$lib/types";
  import { intervals } from "$collections/useIntervals";
  import StatusIcon from "./StatusIcon.svelte";
  import PriorityIcon from "./PriorityIcon.svelte";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";

  interface Props {
    intervalId: string;
    interval: Interval;
    onPropertyUpdate?: (updates: Partial<Pick<Interval, "status" | "priority">>) => void;
  }

  let { intervalId, interval, onPropertyUpdate }: Props = $props();

  const statusOptions = Object.values(Status) as StatusValue[];
  const priorityOptions = Object.values(Priority) as PriorityValue[];

  const collection = intervals.get();

  let editorElement = $state<HTMLDivElement | null>(null);
  let editor = $state<Editor | null>(null);
  let binding = $state<EditorBinding | null>(null);
  let error = $state<string | null>(null);
  let isLoading = $state(true);

  let isEditingTitle = $state(false);
  let editingTitle = $state("");
  let titleInputRef = $state<HTMLInputElement | null>(null);

  const title = $derived(isEditingTitle ? editingTitle : interval.title);

  $effect(() => {
    if (isEditingTitle) {
      titleInputRef?.focus();
    }
  });

  $effect(() => {
    if (browser && binding && editorElement && !editor) {
      void Promise.all([
        import("@tiptap/core"),
        import("@tiptap/starter-kit"),
        import("@tiptap/extension-collaboration"),
        import("@tiptap/extension-placeholder"),
      ]).then(([
        { Editor },
        { default: StarterKit },
        { default: Collaboration },
        { default: Placeholder },
      ]) => {
        if (!editorElement || !binding) return;

        editor = new Editor({
          element: editorElement,
          extensions: [
            StarterKit.configure({}),
            Collaboration.configure({
              fragment: binding.fragment,
            }),
            Placeholder.configure({
              placeholder: "Start writing...",
            }),
          ],
          editorProps: {
            attributes: {
              class: "tiptap-editor prose",
            },
          },
        });
      });
    }
  });

  $effect(() => {
    void intervalId;

    return () => {
      if (editor) {
        editor.destroy();
        editor = null;
      }
      binding = null;
    };
  });

  onMount(async () => {
    if (!browser) return;

    try {
      isLoading = true;
      error = null;
      binding = await collection.utils.prose(intervalId, "description");
      isLoading = false;
    }
    catch (err) {
      error = err instanceof Error ? err.message : "Failed to load editor";
      isLoading = false;
    }
  });

  onDestroy(() => {
    if (editor) {
      editor.destroy();
      editor = null;
    }
  });

  function startEditing() {
    editingTitle = interval.title;
    isEditingTitle = true;
  }

  function handleTitleChange(newTitle: string) {
    editingTitle = newTitle;
  }

  function handleTitleBlur() {
    isEditingTitle = false;
    if (editingTitle.trim() !== interval.title) {
      collection.update(interval.id, (draft) => {
        draft.title = editingTitle.trim() || "Untitled";
        draft.updatedAt = Date.now();
      });
    }
  }

  function handleTitleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
  }
</script>

{#if error}
  <div class="editor-loading" aria-live="polite">
    <p class="text-destructive">Failed to load editor: {error}</p>
  </div>
{:else if isLoading}
  <div class="editor-loading" aria-live="polite" aria-busy="true">
    <div class="editor-loading-spinner"></div>
    <p>Loading editor...</p>
  </div>
{:else}
  <div class="max-w-[680px] mx-auto px-8 py-12 w-full">
    {#if isEditingTitle}
      <input
        bind:this={titleInputRef}
        type="text"
        value={editingTitle}
        oninput={e => handleTitleChange(e.currentTarget.value)}
        onblur={handleTitleBlur}
        onkeydown={handleTitleKeyDown}
        class="w-full font-display text-3xl font-normal text-foreground bg-transparent
          border-none border-b-2 border-primary p-0 pb-1 leading-tight outline-none"
      />
    {:else}
      <button
        type="button"
        class="w-full font-display text-3xl font-normal text-foreground leading-tight
          cursor-text transition-colors hover:text-primary text-left bg-transparent
          border-none p-0"
        onclick={startEditing}
      >
        {title || "Untitled"}
      </button>
    {/if}

    {#if onPropertyUpdate}
      <div class="flex items-center gap-4 mt-4 mb-8 pb-6 border-b border-border text-sm">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-muted transition-colors"
          >
            <StatusIcon status={interval.status} size={14} />
            <span>{StatusLabels[interval.status]}</span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start">
            <DropdownMenu.RadioGroup
              value={interval.status}
              onValueChange={v => onPropertyUpdate({ status: v as StatusValue })}
            >
              {#each statusOptions as status}
                <DropdownMenu.RadioItem value={status}>
                  <StatusIcon {status} size={14} />
                  <span class="ml-2">{StatusLabels[status]}</span>
                </DropdownMenu.RadioItem>
              {/each}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Root>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-muted transition-colors"
          >
            <PriorityIcon priority={interval.priority} size={14} />
            <span>{PriorityLabels[interval.priority]}</span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start">
            <DropdownMenu.RadioGroup
              value={interval.priority}
              onValueChange={v => onPropertyUpdate({ priority: v as PriorityValue })}
            >
              {#each priorityOptions as priority}
                <DropdownMenu.RadioItem value={priority}>
                  <PriorityIcon {priority} size={14} />
                  <span class="ml-2">{PriorityLabels[priority]}</span>
                </DropdownMenu.RadioItem>
              {/each}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    {/if}

    <div class="min-h-[200px]">
      <div bind:this={editorElement}></div>
    </div>
  </div>
{/if}
