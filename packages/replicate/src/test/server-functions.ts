import { componentsGeneric } from 'convex/server';
import { Replicate } from '../server';
const storage = new Replicate((componentsGeneric() as any).replicate, 'records');
export const delta = storage.createDeltaQuery();

export const replicate = storage.createReplicateMutation();
