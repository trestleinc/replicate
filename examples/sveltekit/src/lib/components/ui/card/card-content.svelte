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
  data-slot="card-content"
  class={cn("px-4 group-data-[size=sm]/card:px-3", className)}
  {...restProps}
>
  {@render children?.()}
</div>
