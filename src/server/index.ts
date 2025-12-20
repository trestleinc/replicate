export { replicate } from '$/server/builder.js';
export type { ReplicateConfig } from '$/server/builder.js';

import { table, prose } from '$/server/schema.js';

export const schema = {
  table,
  prose,
} as const;

export type { ReplicationFields } from '$/server/schema.js';
