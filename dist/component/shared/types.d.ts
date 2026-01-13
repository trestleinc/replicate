//#region src/shared/types.d.ts

/** Operation type for streaming changes */
declare enum OperationType {
  Delta = "delta",
  Snapshot = "snapshot",
}
//#endregion
export { OperationType };