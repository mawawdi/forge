import type { CreatorStage } from "../types";

interface EvidenceSpineProps {
  stages: CreatorStage[];
}

export function EvidenceSpine({ stages }: EvidenceSpineProps): React.JSX.Element {
  return (
    <section className="evidence-spine" aria-labelledby="spine-title">
      <div className="evidence-spine__heading">
        <p className="eyebrow">Authority chain</p>
        <h2 id="spine-title">Evidence spine</h2>
      </div>
      <ol className="evidence-spine__list">
        {stages.map((stage) => (
          <EvidenceStage key={stage.id} stage={stage} />
        ))}
      </ol>
    </section>
  );
}

interface EvidenceStageProps {
  stage: CreatorStage;
}

function EvidenceStage({ stage }: EvidenceStageProps): React.JSX.Element {
  return (
    <li
      className={`evidence-stage evidence-stage--${stage.status} evidence-stage--${stage.authority}`}
    >
      <span className="evidence-stage__joint" aria-hidden="true" />
      <span className="evidence-stage__content">
        <strong>{stage.label}</strong>
        <small>{stage.detail}</small>
      </span>
      <span className="authority-label">{stage.authority}</span>
    </li>
  );
}
