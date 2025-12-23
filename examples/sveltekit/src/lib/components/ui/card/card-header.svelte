<script lang="ts">
  import { cn } from "$lib/utils";
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";

  type Props = HTMLAttributes<HTMLDivElement> & {
    children?: Snippet;
  };

  let { class: className, children, ...restProps }: Props = $props();
</script>

<div
  data-slot="card-header"
  class={cn(
    "gap-1 rounded-none px-4 group-data-[size=sm]/card:px-3 [.border-b]:pb-4",
    "group-data-[size=sm]/card:[.border-b]:pb-3 group/card-header @container/card-header",
    "grid auto-rows-min items-start has-data-[slot=card-action]:grid-cols-[1fr_auto]",
    "has-data-[slot=card-description]:grid-rows-[auto_auto]",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</div>
