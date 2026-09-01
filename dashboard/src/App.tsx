import { useEffect } from "react";
import { dashboardStore, useDashboardSnapshot } from "./api-store";
import { getDashboardSurface } from "./derived";
import { AppHeader } from "./components/AppHeader";
import { ArtifactWorkbench } from "./components/ArtifactWorkbench";
import { CapabilityExplorer } from "./components/CapabilityExplorer";
import { DashboardNotice } from "./components/DashboardNotice";
import { EvidenceSpine } from "./components/EvidenceSpine";
import { PromptComposer } from "./components/PromptComposer";
import { SessionHistory } from "./components/SessionHistory";
import { StudioConsentDock } from "./components/StudioConsentDock";

export function App(): React.JSX.Element {
  const snapshot = useDashboardSnapshot();
  const state = snapshot.data;
  const surface = getDashboardSurface(state, snapshot.error);
  const connection = state?.pairedStudio.status ?? "unknown";
  const connectionMessage = state?.pairedStudio.message ?? "Local control plane";
  const promptDisabled = connection !== "paired" || Boolean(snapshot.pendingAction);

  useEffect(() => {
    dashboardStore.start();
  }, []);

  return (
    <main id="control" className={`app-shell app-shell--${surface}`}>
      <AppHeader connection={connection} message={connectionMessage} />
      <DashboardNotice
        surface={surface}
        error={snapshot.error}
        detail={state?.controlView?.detail}
      />
      <div className="dashboard-layout">
        <aside className="left-rail">
          <PromptComposer disabled={promptDisabled} />
          <SessionHistory sessions={state?.sessions ?? []} selectedSessionId={state?.selectedSessionId} />
        </aside>
        <section className="evidence-column" aria-label="Evidence workbench">
          <EvidenceSpine stages={state?.stages ?? []} />
          <ArtifactWorkbench controlView={state?.controlView} />
          <CapabilityExplorer
            catalog={snapshot.catalog}
            pairedStudio={state?.pairedStudio}
            onExplore={dashboardStore.exploreCapabilities}
          />
        </section>
        <StudioConsentDock
          key={state?.controlView?.id ?? "empty-control-view"}
          state={state}
          pendingAction={snapshot.pendingAction}
        />
      </div>
    </main>
  );
}
