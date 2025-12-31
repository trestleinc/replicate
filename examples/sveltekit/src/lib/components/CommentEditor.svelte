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

  // Warm hex collaboration colors matching the design system
  const DEFAULT_COLORS = [
    "#9F5944",   // Rust
    "#A9704D",   // Terracotta
    "#B08650",   // Amber
    "#8A7D3F",   // Gold
    "#6E7644",   // Olive
    "#8C4A42",   // Sienna
    "#9E7656",   // Copper
    "#9A5240",   // Brick
    "#987C4A",   // Bronze
  ];
  const adjectives = ["Swift", "Bright", "Calm", "Bold", "Keen"];
  const nouns = ["Fox", "Owl", "Bear", "Wolf", "Hawk"];

  const localUser = {
    name: `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`,
    color: DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)],
  };

  // Initialize editor when binding is ready (browser only)
  $effect(() => {
    if (browser && binding && editorElement && !editor) {
      void Promise.all([
        import("@tiptap/core"),
        import("@tiptap/starter-kit"),
        import("@tiptap/extension-collaboration"),
        import("@tiptap/extension-collaboration-caret"),
        import("@tiptap/extension-placeholder"),
      ]).then(
        ([
          { Editor },
          { default: StarterKit },
          { default: Collaboration },
          { default: CollaborationCaret },
          { default: Placeholder },
        ]) => {
          if (!editorElement || !binding) return;

          editor = new Editor({
            element: editorElement,
            extensions: [
              StarterKit.configure({ undoRedo: false }),
              Collaboration.configure({
                fragment: binding.fragment,
              }),
              CollaborationCaret.configure({
                provider: binding.provider,
                user: localUser,
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
