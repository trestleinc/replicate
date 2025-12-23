import { useRegisterSW } from "virtual:pwa-register/react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function ReloadPrompt() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  const close = () => {
    setOfflineReady(false);
    setNeedRefresh(false);
  };

  if (!offlineReady && !needRefresh) return null;

  return (
    <Card className="fixed bottom-4 right-4 z-50 flex items-center gap-3 px-4 py-3 shadow-lg animate-in slide-in-from-bottom-2 duration-200">
      <span className="text-sm text-foreground">
        {offlineReady ? "App ready to work offline" : "New content available"}
      </span>
      <div className="flex items-center gap-2">
        {needRefresh && (
          <Button size="sm" onClick={() => updateServiceWorker(true)}>
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
