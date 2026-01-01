export { collection } from "$/server/collection";
export type { CollectionOptions } from "$/server/collection";

import { table, prose } from "$/server/schema";

export const schema = {
  table,
  prose,
} as const;
