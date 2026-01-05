export { collection } from "$/server/collection";
export type { CollectionOptions } from "$/server/collection";
export type { ViewFunction } from "$/server/replicate";

import { table, prose } from "$/server/schema";

export const schema = {
	table,
	prose,
} as const;
