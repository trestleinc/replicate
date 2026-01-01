import { getContext, setContext } from "svelte";
import type { StatusValue, PriorityValue } from "$lib/types";

const FILTER_CONTEXT_KEY = "filters";

export interface FilterContextValue {
  statusFilter: StatusValue | null;
  priorityFilter: PriorityValue | null;
}

export function setFilterContext(value: FilterContextValue) {
  setContext(FILTER_CONTEXT_KEY, value);
}

export function getFilterContext(): FilterContextValue {
  const ctx = getContext<FilterContextValue>(FILTER_CONTEXT_KEY);
  if (!ctx) {
    return {
      statusFilter: null,
      priorityFilter: null,
    };
  }
  return ctx;
}
