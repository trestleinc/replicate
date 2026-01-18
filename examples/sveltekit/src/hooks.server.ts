import type { Handle } from "@sveltejs/kit";
import { createAuth } from "$convex/auth";
import { getToken } from "@mmailaender/convex-better-auth-svelte/sveltekit";

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.token = await getToken(createAuth, event.cookies);

	return resolve(event);
};
