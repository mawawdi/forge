import { useId, useMemo, useState } from "react";
import { useGraphFocus } from "./useGraphFocus";
import type {
  GameBuildControlNode,
  GameBuildControlView,
} from "../../../packages/creator-conversation/src/game-build-contract";
import { GameBuildCanvas } from "./GameBuildCanvas";
import { Icon } from "./Icon";
import "./technical-build-graph.css";

const PAGE_SIZE = 80;
const CHECKPOINT_WINDOW = 7;
const statusLabels = {
  planned: "Planned",
  materialized: "Ready to apply",
  applying: "Applying",
  complete: "Applied",
  stopped: "Stopped",
  recovery_required: "Recovery required",
  ready: "Ready",
  pending: "Pending",
  applied: "Applied",
} as const;
type BuildStatus = keyof typeof statusLabels;

/** Read-only inspection of sealed inventory and retained checkpoint evidence. */
export function GameBuildGraph({
  view,
  historical = false,
}: {
  readonly view: GameBuildControlView;
  readonly historical?: boolean;
}): React.JSX.Element {
  return (
    <section
      className="build-inspector"
      aria-label={historical ? "Saved build implementation" : "Current build implementation"}
    >
      <BuildGraphExplorer key={view.planHash} view={view} historical={historical} />
    </section>
  );
}

function BuildGraphExplorer({
  view,
  historical,
}: {
  readonly view: GameBuildControlView;
  readonly historical: boolean;
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>();
  const [component, setComponent] = useState("");
  const [search, setSearch] = useState("");
  const [partitionId, setPartitionId] = useState("");
  const [mode, setMode] = useState<"graph" | "list">("graph");
  const [page, setPage] = useState(0);
  const { root, requestFocus } = useGraphFocus();
  const descriptionId = useId();
  const components = useMemo(
    () => view.components.map((item) => item.id).sort(),
    [view.components],
  );
  const selectedPartition = view.partitions.find((partition) =>
    partition.nodeIds.includes(selectedId ?? ""),
  );
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const partition = view.partitions.find((candidate) => candidate.id === partitionId);
    const ids = partition ? new Set(partition.nodeIds) : undefined;
    return view.nodes.filter(
      (node) =>
        (!component || node.componentId === component) &&
        (!ids || ids.has(node.id)) &&
        (!query ||
          `${node.label} ${node.path} ${node.className} ${node.componentId}`
            .toLocaleLowerCase()
            .includes(query)),
    );
  }, [component, search, partitionId, view.nodes, view.partitions]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = useMemo(
    () => filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE),
    [filtered, currentPage],
  );
  const selected = visible.find((node) => node.id === selectedId);
  const hasFilters = Boolean(search.trim() || component || partitionId);
  const applied = view.partitions.filter((partition) => partition.status === "applied").length;
  const observedSources = view.components.reduce((total, item) => total + item.observedSources, 0);
  const selectedCheckpointIndex = view.partitions.findIndex(
    (partition) => partition.id === partitionId,
  );
  const activeCheckpointIndex = view.partitions.findIndex(
    (partition) => partition.status !== "applied",
  );
  const checkpointStart = Math.max(
    0,
    Math.min(
      view.partitions.length - CHECKPOINT_WINDOW,
      Math.max(0, selectedCheckpointIndex >= 0 ? selectedCheckpointIndex : activeCheckpointIndex) -
        2,
    ),
  );
  const checkpoints = view.partitions.slice(checkpointStart, checkpointStart + CHECKPOINT_WINDOW);
  function selectCheckpoint(id: string): void {
    setPartitionId(id);
    setPage(0);
    setSelectedId(undefined);
  }
  function resetFilters(): void {
    setSearch("");
    setComponent("");
    setPartitionId("");
    setPage(0);
    setSelectedId(undefined);
    requestFocus();
  }
  function selectNode(id: string): void {
    setSelectedId(id);
    requestFocus(id);
  }
  function showRelated(id: string): void {
    const related = view.nodes.find((node) => node.id === id)!;
    setSelectedId(id);
    requestFocus(id);
    setComponent(related.componentId);
    setPartitionId("");
    setSearch("");
    setPage(
      Math.floor(
        view.nodes
          .filter((node) => node.componentId === related.componentId)
          .findIndex((node) => node.id === id) / PAGE_SIZE,
      ),
    );
  }
  return (
    <div className="build-inspector__body" ref={root}>
      <header className="build-inspector__overview">
        <div className="build-inspector__heading">
          <span className="build-inspector__heading-icon">
            <Icon name="code" size={22} />
          </span>
          <div>
            <span className="build-inspector__eyebrow">
              {historical ? "Saved snapshot" : "Current plan"} · Read only
            </span>
            <h3>Build implementation</h3>
          </div>
          <span role="status" aria-atomic="true">
            <StatusBadge status={view.status} />
          </span>
        </div>
        <p id={descriptionId} className="build-inspector__caption">
          {historical
            ? "This snapshot stays pinned to its original plan and checkpoints."
            : "Inspect the objects, source, and dependencies in this plan."}{" "}
          Applied means editor writes have a verified checkpoint; gameplay checks are separate.
        </p>
        <dl className="build-inspector__metrics">
          <div>
            <dt>Objects</dt>
            <dd>{view.nodes.length.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Components</dt>
            <dd>{view.components.length.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Source files</dt>
            <dd>
              {(view.nodes.filter((node) => node.source).length + observedSources).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt>Property slots</dt>
            <dd>
              {view.nodes
                .reduce((count, node) => count + node.valueSlots.length, 0)
                .toLocaleString()}
            </dd>
          </div>
        </dl>
      </header>
      {view.stoppedReason ? (
        <div className="build-inspector__notice" role="status">
          <Icon name="stop" size={18} />
          <div>
            <strong>
              {view.status === "recovery_required" ? "Recovery requires attention" : "Build paused"}
            </strong>
            <p>{view.stoppedReason}</p>
          </div>
        </div>
      ) : null}
      {view.partitions.length ? (
        <section className="build-inspector__checkpoint-section" aria-label="Build checkpoints">
          <div className="build-inspector__section-heading">
            <div>
              <h4>Checkpoint progress</h4>
              <p role="status" aria-atomic="true">
                {applied} of {view.partitions.length} applied
              </p>
            </div>
            <button
              type="button"
              className="build-inspector__quiet-button"
              aria-pressed={!partitionId}
              onClick={() => selectCheckpoint("")}
            >
              All checkpoints
            </button>
          </div>
          <progress
            className="build-inspector__progress"
            aria-label="Applied checkpoints"
            value={applied}
            max={view.partitions.length}
          />
          <ol className="build-inspector__checkpoints">
            {checkpoints.map((partition) => (
              <li key={partition.id}>
                <button
                  type="button"
                  aria-pressed={partitionId === partition.id}
                  aria-label={`Checkpoint ${partition.ordinal + 1}, ${statusLabels[partition.status]}`}
                  onClick={() => selectCheckpoint(partition.id)}
                >
                  <span
                    className={`build-inspector__step build-inspector__step--${partition.status}`}
                  >
                    {partition.status === "applied" ? (
                      <Icon name="check" size={16} />
                    ) : (
                      partition.ordinal + 1
                    )}
                  </span>
                  <span>
                    <strong>Checkpoint {partition.ordinal + 1}</strong>
                    <small>
                      {statusLabels[partition.status]} · {partition.nodeIds.length}{" "}
                      {partition.nodeIds.length === 1 ? "object" : "objects"}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {view.partitions.length > CHECKPOINT_WINDOW ? (
            <label className="build-inspector__checkpoint-jump">
              <span>
                Showing {checkpointStart + 1}–{checkpointStart + checkpoints.length} of{" "}
                {view.partitions.length}
              </span>
              <select
                aria-label="Jump to checkpoint"
                value={partitionId}
                onChange={(event) => selectCheckpoint(event.target.value)}
              >
                <option value="">All checkpoints</option>
                {view.partitions.map((partition) => (
                  <option value={partition.id} key={partition.id}>
                    Checkpoint {partition.ordinal + 1} · {statusLabels[partition.status]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </section>
      ) : (
        <div className="build-inspector__pending">
          <Icon name="details" size={18} />
          <p>
            {view.graphHash
              ? "This build has no editor checkpoints."
              : "Checkpoint progress appears after source and property slots are materialized."}
          </p>
        </div>
      )}
      <div className="build-inspector__inventory">
        <div className="build-inspector__section-heading">
          <div>
            <h4>Explore the inventory</h4>
            <p>
              {component ? `Component: ${component}` : "All components"}
              {partitionId
                ? ` · Checkpoint ${view.partitions.find((item) => item.id === partitionId)!.ordinal + 1}`
                : ""}
            </p>
          </div>
          <div className="build-inspector__modes" role="group" aria-label="Graph display">
            <button type="button" aria-pressed={mode === "graph"} onClick={() => setMode("graph")}>
              <Icon name="graph" size={16} />
              Graph
            </button>
            <button type="button" aria-pressed={mode === "list"} onClick={() => setMode("list")}>
              <Icon name="details" size={16} />
              List
            </button>
          </div>
        </div>
        <div className="build-inspector__toolbar">
          <label className="build-inspector__search-label">
            <span>Find an object</span>
            <span className="build-inspector__search">
              <Icon name="search" size={17} />
              <input
                type="search"
                value={search}
                placeholder="Name, path, or class"
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                  setSelectedId(undefined);
                }}
              />
            </span>
          </label>
          <label>
            <span>Component</span>
            <select
              value={component}
              onChange={(event) => {
                setComponent(event.target.value);
                setPage(0);
                setSelectedId(undefined);
              }}
            >
              <option value="">All components</option>
              {components.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="build-inspector__range">
          <span role="status" aria-atomic="true">
            {filtered.length
              ? `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of ${filtered.length} objects`
              : hasFilters
                ? "No matching objects"
                : "No editor objects"}
          </span>
          <span className="build-inspector__range-actions">
            {hasFilters ? (
              <button
                type="button"
                className="build-inspector__quiet-button"
                onClick={resetFilters}
              >
                Clear filters
              </button>
            ) : null}
            {pageCount > 1 ? (
              <>
                <button
                  type="button"
                  aria-label="Previous objects"
                  disabled={currentPage === 0}
                  onClick={() => {
                    setPage(currentPage - 1);
                    setSelectedId(undefined);
                    requestFocus();
                  }}
                >
                  <span className="build-inspector__previous">
                    <Icon name="chevronRight" size={17} />
                  </span>
                </button>
                <span>
                  {currentPage + 1} / {pageCount}
                </span>
                <button
                  type="button"
                  aria-label="Next objects"
                  disabled={currentPage + 1 === pageCount}
                  onClick={() => {
                    setPage(currentPage + 1);
                    setSelectedId(undefined);
                    requestFocus();
                  }}
                >
                  <Icon name="chevronRight" size={17} />
                </button>
              </>
            ) : null}
          </span>
        </div>
        <div
          className={`build-inspector__workspace${selected ? " build-inspector__workspace--selected" : ""}`}
        >
          <div className="build-inspector__surface" aria-describedby={descriptionId}>
            {mode === "graph" &&
            (visible.length > 0 || (!hasFilters && view.components.length > 0)) ? (
              <GameBuildCanvas
                view={view}
                filtered={filtered}
                visible={visible}
                component={component}
                searching={Boolean(search.trim() || partitionId)}
                selectedId={selectedId}
                onNode={selectNode}
                onComponent={(id) => {
                  setComponent(id);
                  setSelectedId(undefined);
                  setPage(0);
                  requestFocus();
                }}
              />
            ) : mode === "list" && visible.length ? (
              <ul className="build-inspector__list" aria-label="Build objects">
                {visible.map((node) => (
                  <li key={node.id}>
                    <button
                      type="button"
                      aria-pressed={node.id === selectedId}
                      data-graph-node={node.id}
                      onClick={() => selectNode(node.id)}
                    >
                      <span className="build-inspector__object-icon">
                        <Icon
                          name={
                            node.source ? "code" : node.className === "Folder" ? "folder" : "file"
                          }
                          size={19}
                        />
                      </span>
                      <span className="build-inspector__object-name">
                        <strong>{node.label}</strong>
                        <small>{node.path}</small>
                      </span>
                      <span className="build-inspector__object-class">{node.className}</span>
                      <StatusBadge status={node.status} />
                      <Icon name="chevronRight" size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="build-inspector__empty">
                <span>
                  <Icon name={hasFilters ? "search" : "folder"} size={28} />
                </span>
                <h4>{hasFilters ? "Nothing in this view" : "No editor changes in this plan"}</h4>
                <p>
                  {hasFilters
                    ? "Try another name or clear the filters to return to the full inventory."
                    : observedSources
                      ? `This plan uses ${observedSources} existing source ${observedSources === 1 ? "file" : "files"} without writing editor objects.`
                      : "Objects will appear here when they are included in the sealed plan."}
                </p>
                {hasFilters ? (
                  <button type="button" onClick={resetFilters}>
                    Show all objects
                  </button>
                ) : null}
              </div>
            )}
          </div>
          {selected ? (
            <NodeDetails
              key={selected.id}
              node={selected}
              view={view}
              partition={selectedPartition}
              onSelect={showRelated}
              onClose={() => {
                setSelectedId(undefined);
                requestFocus(selected.id);
              }}
            />
          ) : null}
        </div>
      </div>
      <details className="build-inspector__disclosure build-inspector__binding">
        <summary>
          <Icon name="link" size={16} />
          <span>Plan and build identifiers</span>
          <Icon name="chevronDown" size={16} />
        </summary>
        <dl>
          <div>
            <dt>Plan hash</dt>
            <dd>
              <code>{view.planHash}</code>
            </dd>
          </div>
          {view.graphHash ? (
            <div>
              <dt>Build hash</dt>
              <dd>
                <code>{view.graphHash}</code>
              </dd>
            </div>
          ) : null}
        </dl>
      </details>
    </div>
  );
}

function StatusBadge({ status }: { readonly status: BuildStatus }): React.JSX.Element {
  return (
    <span className={`build-inspector__status build-inspector__status--${status}`}>
      <span className="build-inspector__status-mark" aria-hidden="true">
        {status === "applied" || status === "complete" ? (
          <Icon name="check" size={13} />
        ) : status === "stopped" || status === "recovery_required" ? (
          <Icon name="stop" size={11} />
        ) : (
          <span />
        )}
      </span>
      {statusLabels[status]}
    </span>
  );
}

function NodeDetails({
  node,
  view,
  onSelect,
  onClose,
  partition,
}: {
  readonly node: GameBuildControlNode;
  readonly view: GameBuildControlView;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
  readonly partition: GameBuildControlView["partitions"][number] | undefined;
}): React.JSX.Element {
  const byId = new Map(view.nodes.map((item) => [item.id, item]));
  const hasIdentifiers = Boolean(node.source?.sourceHash || partition?.receiptHash);
  return (
    <section className="build-inspector__details" aria-label="Selected object details">
      <header>
        <div>
          <span className="build-inspector__eyebrow">{node.componentId}</span>
          <h3>{node.label}</h3>
        </div>
        <button type="button" aria-label="Close object details" onClick={onClose}>
          <Icon name="close" size={17} />
        </button>
      </header>
      <div className="build-inspector__detail-status">
        <StatusBadge status={node.status} />
        <span>
          {node.operation.replaceAll("_", " ")} · {node.className}
        </span>
      </div>
      <dl className="build-inspector__facts">
        <div>
          <dt>Studio path</dt>
          <dd>
            <code>{node.path}</code>
          </dd>
        </div>
        <div>
          <dt>Origin</dt>
          <dd>{node.provenance.componentKind.replaceAll("_", " ")}</dd>
        </div>
        {partition ? (
          <div>
            <dt>Checkpoint</dt>
            <dd>
              {partition.ordinal + 1} · {statusLabels[partition.status]}
            </dd>
          </div>
        ) : null}
      </dl>
      {node.source ? (
        <div className="build-inspector__source">
          <Icon name="code" size={20} />
          <div>
            <strong>Source · {node.source.fileId}</strong>
            <p>
              {node.source.kind === "locked"
                ? `Locked source · ${node.source.utf8Bytes} UTF-8 bytes`
                : `Source slot · up to ${node.source.maximumUtf8Bytes} UTF-8 bytes`}
            </p>
          </div>
        </div>
      ) : null}
      {node.valueSlots.length ? (
        <details className="build-inspector__disclosure" open>
          <summary>
            <span>
              Property slots <small>{node.valueSlots.length}</small>
            </span>
            <Icon name="chevronDown" size={16} />
          </summary>
          <div className="build-inspector__property-list">
            {node.valueSlots.map((slot) => (
              <details className="build-inspector__property" key={slot.id}>
                <summary>
                  <strong>{slot.propertyName}</strong>
                  <span>
                    Schema <Icon name="chevronDown" size={13} />
                  </span>
                </summary>
                <small>Slot: {slot.id}</small>
                <pre tabIndex={0} aria-label={`${slot.propertyName} slot schema`}>
                  {JSON.stringify(slot.schema, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        </details>
      ) : null}
      {Object.keys(node.lockedProperties).length ? (
        <details className="build-inspector__disclosure">
          <summary>
            <span>
              Locked properties <small>{Object.keys(node.lockedProperties).length}</small>
            </span>
            <Icon name="chevronDown" size={16} />
          </summary>
          <dl className="build-inspector__properties">
            {Object.entries(node.lockedProperties).map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>
                  <code>{JSON.stringify(value)}</code>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      <div className="build-inspector__relations">
        {(
          [
            {
              label: "Requires",
              edges: view.edges.filter((edge) => edge.from === node.id),
              field: "to",
            },
            {
              label: "Required by",
              edges: view.edges.filter((edge) => edge.to === node.id),
              field: "from",
            },
          ] as const
        ).map((group) => (
          <div key={group.label}>
            <h4>
              {group.label}
              <small>{group.edges.length}</small>
            </h4>
            {group.edges.length ? (
              <ul>
                {group.edges.map((edge) => (
                  <li key={`${edge.from}:${edge.to}:${edge.kind}`}>
                    <button
                      type="button"
                      aria-label={`${byId.get(edge[group.field])?.label}, ${edge.kind}`}
                      onClick={() => onSelect(edge[group.field])}
                    >
                      <Icon name={edge.kind === "parent" ? "folder" : "link"} size={16} />
                      <span>
                        <strong>{byId.get(edge[group.field])?.label}</strong>
                        <small>{edge.kind === "parent" ? "Parent object" : "Dependency"}</small>
                      </span>
                      <Icon name="chevronRight" size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No {group.label === "Requires" ? "prerequisites" : "dependent objects"}.</p>
            )}
          </div>
        ))}
      </div>
      {hasIdentifiers ? (
        <details className="build-inspector__disclosure">
          <summary>
            <span>Evidence identifiers</span>
            <Icon name="chevronDown" size={16} />
          </summary>
          <dl className="build-inspector__facts">
            {[
              { label: "Source hash", value: node.source?.sourceHash },
              { label: "Checkpoint receipt", value: partition?.receiptHash },
            ]
              .filter((item) => item.value)
              .map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>
                    <code>{item.value}</code>
                  </dd>
                </div>
              ))}
          </dl>
        </details>
      ) : null}
    </section>
  );
}
