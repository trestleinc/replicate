import { persistence, type Persistence } from "@trestleinc/replicate/client";

export const sqlite = persistence.web.sqlite.once({
  name: "replicate",
  worker: async () => {
    const { default: SqliteWorker } = await import("@trestleinc/replicate/worker?worker");
    return new SqliteWorker();
  },
});

let encryptedPersistenceRef: Persistence | null = null;

export function setEncryptedPersistence(p: Persistence | null): void {
  encryptedPersistenceRef = p;
}

export function getEncryptedPersistence(): Persistence | null {
  return encryptedPersistenceRef;
}

export async function createPersistence(): Promise<Persistence> {
  if (encryptedPersistenceRef) {
    return encryptedPersistenceRef;
  }
  return sqlite();
}
