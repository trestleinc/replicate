//#region src/shared/types.ts
/** Operation type for streaming changes */
let OperationType = /* @__PURE__ */ function(OperationType$1) {
	OperationType$1["Delta"] = "delta";
	OperationType$1["Snapshot"] = "snapshot";
	return OperationType$1;
}({});
const SIZE_MULTIPLIERS = {
	kb: 1024,
	mb: 1024 ** 2,
	gb: 1024 ** 3
};

//#endregion
export { OperationType };