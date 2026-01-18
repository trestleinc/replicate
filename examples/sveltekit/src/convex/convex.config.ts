import { defineApp } from "convex/server";
import replicate from "@trestleinc/replicate/convex.config";
import betterAuth from "@convex-dev/better-auth/convex.config";

const app = defineApp();
app.use(replicate);
app.use(betterAuth);

export default app;
