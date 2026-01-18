import { persistence } from "@trestleinc/replicate/client";

export const sqlite = persistence.web.sqlite.once({
	name: "replicate",
	worker: async () => {
		const { default: SqliteWorker } = await import("@trestleinc/replicate/worker?worker");
		return new SqliteWorker();
	},
});
