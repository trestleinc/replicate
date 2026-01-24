import { defineSchema } from 'convex/server';
import { intervalSchema } from './schema/intervals';
import { commentSchema } from './schema/comments';

export default defineSchema({
	intervals: intervalSchema.table(),
	comments: commentSchema.table(),
});
