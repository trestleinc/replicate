import { type Logger, getLogger as getLogTapeLogger } from "@logtape/logtape";

export function getLogger(category: string[]): Logger {
	return getLogTapeLogger(["replicate", ...category]);
}
