import {
	configure,
	getConsoleSink,
	getAnsiColorFormatter,
	getLogger as getLogTapeLogger,
	type Logger,
} from "@logtape/logtape";

const PROJECT_NAME = "replicate";

// Configure LogTape with colored console output
// Using reset: true allows reconfiguration if already configured
configure({
	reset: true,
	sinks: {
		console: getConsoleSink({
			formatter: getAnsiColorFormatter({
				timestamp: "time",
				level: "ABBR",
				category: cat => cat.join(":"),
			}),
		}),
	},
	loggers: [
		{
			category: [PROJECT_NAME],
			sinks: ["console"],
			lowestLevel: "debug",
		},
	],
});

export function getLogger(category: string[]): Logger {
	return getLogTapeLogger([PROJECT_NAME, ...category]);
}

export type { Logger };
