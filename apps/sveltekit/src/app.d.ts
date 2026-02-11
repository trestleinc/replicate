/// <reference types="@cloudflare/workers-types" />

declare global {
	namespace App {
		interface Locals {
			token: string | undefined;
		}
		interface Platform {
			env: Record<string, unknown>;
		}
	}
}

export {};
