import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { schema } from "@trestleinc/replicate/client";
import { useIntervalsContext } from "../contexts/IntervalsContext";
import { Status, Priority, type Interval } from "../types/interval";

export function useCreateInterval() {
	const { collection } = useIntervalsContext();
	const navigate = useNavigate();

	return useCallback(async () => {
		const id = crypto.randomUUID();
		const now = Date.now();

		collection.insert({
			id,
			title: "Untitled",
			description: schema.prose.empty(),
			status: Status.BACKLOG,
			priority: Priority.NONE,
			createdAt: now,
			updatedAt: now,
		} as Interval);

		await new Promise(r => setTimeout(r, 100));
		navigate({ to: "/intervals/$intervalId", params: { intervalId: id } });
	}, [collection, navigate]);
}
