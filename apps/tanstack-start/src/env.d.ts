/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
	readonly PUBLIC_CONVEX_URL: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}

declare module '*.css?url' {
	const src: string;
	export default src;
}
