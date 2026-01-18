<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import { comments } from "$collections/useComments";

  interface Props {
    commentId: string;
    body: string;
  }

  let { commentId, body }: Props = $props();

  const collection = comments.get();

  let isEditing = $state(false);
  let editedBody = $state("");

  $effect(() => {
    if (!isEditing) {
      editedBody = body;
    }
  });

  function handleBlur() {
    if (editedBody.trim() !== body) {
      collection.update(commentId, (draft) => {
        draft.body = editedBody.trim();
        draft.updatedAt = Date.now();
      });
    }
    isEditing = false;
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
    if (e.key === "Escape") {
      editedBody = body;
      isEditing = false;
    }
  }
</script>

{#if isEditing}
  <Input
    bind:value={editedBody}
    onblur={handleBlur}
    onkeydown={handleKeyDown}
    class="text-sm h-auto py-1"
  />
{:else}
  <button
    type="button"
    class="text-sm text-left w-full hover:bg-muted/50 rounded px-1 -mx-1 cursor-text"
    onclick={() => isEditing = true}
  >
    {body}
  </button>
{/if}
