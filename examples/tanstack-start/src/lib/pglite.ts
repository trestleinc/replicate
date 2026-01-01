import { persistence } from "@trestleinc/replicate/client";

export const pglite = persistence.pglite.once(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { live } = await import("@electric-sql/pglite/live");
  return PGlite.create({
    dataDir: "idb://replicate",
    relaxedDurability: true,
    extensions: { live },
  });
});
