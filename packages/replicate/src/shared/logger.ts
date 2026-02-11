import { getLogger as getLogTapeLogger, type Logger } from '@logtape/logtape';

const PROJECT_NAME = 'replicate';

export function getLogger(category: string[]): Logger {
	return getLogTapeLogger([PROJECT_NAME, ...category]);
}

export type { Logger };
