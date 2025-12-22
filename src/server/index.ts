export { replicate } from '$/server/builder';
export type { ReplicateConfig } from '$/server/builder';

import { table, prose } from '$/server/schema';

export const schema = {
  table,
  prose,
} as const;

export type { ReplicationFields } from '$/server/schema';
