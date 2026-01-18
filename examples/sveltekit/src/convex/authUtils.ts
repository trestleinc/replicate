import { authComponent } from "./auth";

interface AuthCtx {
	auth: { getUserIdentity: () => Promise<{ subject: string } | null> };
}

export async function getAuthUserId<T extends AuthCtx>(ctx: T): Promise<string | null> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) return null;
	const authUser = await authComponent.getAuthUser(
		ctx as unknown as Parameters<typeof authComponent.getAuthUser>[0],
	);
	return authUser?._id ?? identity.subject;
}
