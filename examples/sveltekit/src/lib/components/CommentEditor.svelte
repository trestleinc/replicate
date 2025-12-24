<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { browser } from "$app/environment";
  import type { Editor } from "@tiptap/core";
  import type { EditorBinding } from "@trestleinc/replicate/client";
  import { comments } from "$collections/useComments";

  interface Props {
    commentId: string;
  }

  let { commentId }: Props = $props();

  const collection = comments.get();

  let editorElement = $state<HTMLDivElement | null>(null);
  let editor = $state<Editor | null>(null);
  let binding = $state<EditorBinding | null>(null);
  let error = $state<string | null>(null);
  let isLoading = $state(true);

  // Initialize editor when binding is ready (browser only)
  $effect(() => {
    if (browser && binding && editorElement && !editor) {
      void Promise.all([
        import("@tiptap/core"),
        import("@tiptap/starter-kit"),
        import("@tiptap/extension-collaboration"),
        import("@tiptap/extension-placeholder"),
      ]).then(
        ([
          { Editor },
          { default: StarterKit },
          { default: Collaboration },
          { default: Placeholder },
        ]) => {
          if (!editorElement || !binding) return;

          editor = new Editor({
            element: editorElement,
            extensions: [
              StarterKit.configure({
                // Disable history - Yjs handles undo/redo
              }),
              Collaboration.configure({
                fragment: binding.fragment,
              }),
              Placeholder.configure({
                placeholder: "Write a comment...",
              }),
            ],
            editorProps: {
              attributes: {
                class: "tiptap-editor comment-editor prose text-sm outline-none",
              },
            },
          });
        },
      );
    }
  });

  // Cleanup on commentId change or unmount
  $effect(() => {
    // Track commentId to trigger cleanup on change
    void commentId;

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
      binding = await collection.utils.prose(commentId, "body");
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
</script>

{#if error}
  <p class="text-sm text-destructive">Failed to load comment</p>
{:else if isLoading}
  <p class="text-sm text-muted-foreground">Loading...</p>
{:else}
  <div bind:this={editorElement}></div>
{/if}
