import { createContext, useContext, useState, type ReactNode } from "react";
import type { StatusValue, PriorityValue } from "@/types/interval";

interface FilterContextValue {
	statusFilter: StatusValue | null;
	priorityFilter: PriorityValue | null;
	setStatusFilter: (status: StatusValue | null) => void;
	setPriorityFilter: (priority: PriorityValue | null) => void;
	clearFilters: () => void;
	hasActiveFilters: boolean;
}

const FilterContext = createContext<FilterContextValue | null>(null);

export function FilterProvider({ children }: { children: ReactNode }) {
	const [statusFilter, setStatusFilter] = useState<StatusValue | null>(null);
	const [priorityFilter, setPriorityFilter] = useState<PriorityValue | null>(null);

	const hasActiveFilters = statusFilter !== null || priorityFilter !== null;

	const clearFilters = () => {
		setStatusFilter(null);
		setPriorityFilter(null);
	};

	return (
		<FilterContext.Provider
			value={{
				statusFilter,
				priorityFilter,
				setStatusFilter,
				setPriorityFilter,
				clearFilters,
				hasActiveFilters,
			}}
		>
			{children}
		</FilterContext.Provider>
	);
}

export function useFilterContext() {
	const ctx = useContext(FilterContext);
	if (!ctx) {
		throw new Error("useFilterContext must be used within FilterProvider");
	}
	return ctx;
}
