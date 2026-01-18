import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function ReloadPrompt() {
	const [offlineReady, setOfflineReady] = useState(false);
	const [needRefresh, setNeedRefresh] = useState(false);
	const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

	useEffect(() => {
		if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
			return;
		}

		if (import.meta.env.DEV) {
			return;
		}

		navigator.serviceWorker
			.register("/sw.js", { scope: "/" })
			.then(reg => {
				setRegistration(reg);

				if (reg.waiting) {
					setNeedRefresh(true);
				}

				reg.addEventListener("updatefound", () => {
					const newWorker = reg.installing;
					if (newWorker) {
						newWorker.addEventListener("statechange", () => {
							if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
								setNeedRefresh(true);
							} else if (newWorker.state === "installed") {
								setOfflineReady(true);
							}
						});
					}
				});
			})
			.catch(() => {
				/* SW registration failure is non-fatal */
			});

		const handleControllerChange = () => {
			window.location.reload();
		};

		navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);

		return () => {
			navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
		};
	}, []);

	const updateServiceWorker = () => {
		if (registration?.waiting) {
			registration.waiting.postMessage({ type: "SKIP_WAITING" });
		}
	};

	const close = () => {
		setOfflineReady(false);
		setNeedRefresh(false);
	};

	if (!offlineReady && !needRefresh) return null;

	const cardClass = [
		"fixed bottom-4 right-4 z-50 flex items-center gap-3 px-4 py-3",
		"shadow-lg animate-in slide-in-from-bottom-2 duration-200",
	].join(" ");

	return (
		<Card className={cardClass}>
			<span className="text-sm text-foreground">
				{offlineReady ? "App ready to work offline" : "New content available"}
			</span>
			<div className="flex items-center gap-2">
				{needRefresh && (
					<Button size="sm" onClick={updateServiceWorker}>
						Reload
					</Button>
				)}
				<Button variant="ghost" size="sm" onClick={close}>
					Close
				</Button>
			</div>
		</Card>
	);
}
