/// <reference lib="webworker" />

import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import { NetworkFirst, CacheFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

const ONE_DAY = 24 * 60 * 60;
const ONE_WEEK = 7 * ONE_DAY;
const ONE_MONTH = 30 * ONE_DAY;

registerRoute(
	new NavigationRoute(
		new NetworkFirst({
			cacheName: "pages-cache",
			networkTimeoutSeconds: 3,
			plugins: [
				new ExpirationPlugin({
					maxEntries: 50,
					maxAgeSeconds: ONE_DAY,
				}),
			],
		}),
	),
);

registerRoute(
	({ url }) => url.hostname.includes(".convex.cloud"),
	new NetworkFirst({
		cacheName: "convex-api-cache",
		networkTimeoutSeconds: 3,
		plugins: [
			new ExpirationPlugin({
				maxEntries: 100,
				maxAgeSeconds: ONE_DAY,
			}),
		],
	}),
);

registerRoute(
	({ request }) =>
		request.destination === "style" ||
		request.destination === "script" ||
		request.destination === "font",
	new CacheFirst({
		cacheName: "static-assets",
		plugins: [
			new ExpirationPlugin({
				maxEntries: 100,
				maxAgeSeconds: ONE_WEEK,
			}),
		],
	}),
);

registerRoute(
	({ request }) => request.destination === "image",
	new CacheFirst({
		cacheName: "images-cache",
		plugins: [
			new ExpirationPlugin({
				maxEntries: 50,
				maxAgeSeconds: ONE_MONTH,
			}),
		],
	}),
);

self.addEventListener("message", event => {
	if ((event.data as { type?: string })?.type === "SKIP_WAITING") {
		void self.skipWaiting();
	}
});
