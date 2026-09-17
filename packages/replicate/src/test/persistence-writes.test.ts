import { expect, test } from 'vitest';
import { PersistenceWrites } from '../client/persistence/writes';

test('flush drains writes added at the previous drain completion boundary', async () => {
	const writes = new PersistenceWrites();
	const events: string[] = [];
	let capturedFlush: Promise<void> | undefined;
	writes.add(async () => {
		events.push('first');
		queueMicrotask(() =>
			queueMicrotask(() => {
				writes.add(async () => {
					events.push('second');
				});
				capturedFlush = writes.flush();
			})
		);
	});
	await writes.flush();
	await capturedFlush;
	expect(events).toEqual(['first', 'second']);
});
