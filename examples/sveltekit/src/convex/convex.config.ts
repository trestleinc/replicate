import { defineApp } from "convex/server";
import replicate from "@trestleinc/replicate/convex.config";

const app = defineApp();
app.use(replicate);

export default app;
