import { anyApi, componentsGeneric } from "convex/server";

//#region src/component/_generated/api.ts
/**
* A utility for referencing Convex functions in your app's public API.
*
* Usage:
* ```js
* const myFunctionReference = api.myModule.myFunction;
* ```
*/
const api = anyApi;
/**
* A utility for referencing Convex functions in your app's internal API.
*
* Usage:
* ```js
* const myFunctionReference = internal.myModule.myFunction;
* ```
*/
const internal = anyApi;
const components = componentsGeneric();

//#endregion
export { api, components, internal };