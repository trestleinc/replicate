<script lang="ts">
  import { cn } from "$lib/utils";
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";

  type Props = HTMLAttributes<HTMLDivElement> & {
    size?: "default" | "sm";
    children?: Snippet;
  };

  let { class: className, size = "default", children, ...restProps }: Props = $props();
</script>

<div
  data-slot="card"
  data-size={size}
  class={cn(
    "ring-foreground/10 bg-card text-card-foreground gap-4 overflow-hidden rounded-none",
    "py-4 text-xs/relaxed ring-1 has-data-[slot=card-footer]:pb-0",
    "has-[>img:first-child]:pt-0 data-[size=sm]:gap-2 data-[size=sm]:py-3",
    "data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-none",
    "*:[img:last-child]:rounded-none group/card flex flex-col",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</div>
