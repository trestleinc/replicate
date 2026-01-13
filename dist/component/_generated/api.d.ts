import { logger_d_exports } from "../logger.js";
import { mutations_d_exports } from "../mutations.js";
import { ApiFromModules, FilterApi, FunctionReference } from "convex/server";

//#region src/component/_generated/api.d.ts

declare const fullApi: ApiFromModules<{
  logger: typeof logger_d_exports;
  mutations: typeof mutations_d_exports;
}>;
/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;
declare const components: {};
//#endregion
export { api, components, internal };