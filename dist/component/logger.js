//#region src/component/logger.ts
var ComponentLogger = class {
	constructor(category) {
		this.category = category;
	}
	format(level, message, context) {
		return `${`[${this.category.join(":")}]`} ${level}: ${message}${context ? ` ${JSON.stringify(context)}` : ""}`;
	}
	debug(message, context) {
		console.log(this.format("DEBUG", message, context));
	}
	info(message, context) {
		console.log(this.format("INFO", message, context));
	}
	warn(message, context) {
		console.warn(this.format("WARN", message, context));
	}
	error(message, context) {
		console.error(this.format("ERROR", message, context));
	}
};
function getLogger(category) {
	return new ComponentLogger(["component", ...category]);
}

//#endregion
export { getLogger };