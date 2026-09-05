import { useRef, useState } from "react";
import type { GameBuildControlView } from "../../../packages/creator-conversation/src/game-build-contract";
import { GameBuildCanvas } from "./GameBuildCanvas";
import { Icon } from "./Icon";
import { useGraphFocus } from "./useGraphFocus";
import "./game-build-graph.css";

const PAGE_SIZE = 80;
/** Only authored game concepts belong on this canvas. Build evidence lives in the details sheet. */
export function GameSystemExplorer({
  view,
}: {
  readonly view: GameBuildControlView;
  readonly historical?: boolean;
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        window.matchMedia?.("(max-width: 600px)").matches
          ? []
          : view.architecture?.nodes.filter((node) => !node.parentId).map((node) => node.id),
      ),
  );
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"graph" | "list">("graph");
  const [page, setPage] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const { root, requestFocus } = useGraphFocus();
  const architecture = view.architecture;
  if (!architecture)
    return (
      <div className="game-map__empty">
        <span className="game-map__empty-art">
          <Icon name="graph" size={44} />
        </span>
        <h3>No game system map declared</h3>
        <p>
          This plan does not include named game systems. When it does, explore their purpose and
          connections here.
        </p>
      </div>
    );
  const byId = new Map(architecture.nodes.map((node) => [node.id, node]));
  const query = search.trim().toLocaleLowerCase();
  const matching = new Set(
    architecture.nodes
      .filter((node) => `${node.name} ${node.description}`.toLocaleLowerCase().includes(query))
      .map((node) => node.id),
  );
  if (query)
    for (const id of [...matching]) {
      let parent = byId.get(id)?.parentId;
      while (parent) {
        matching.add(parent);
        parent = byId.get(parent)?.parentId;
      }
    }
  const filtered = architecture.nodes.filter((node) => {
    if (query) return matching.has(node.id);
    let parent = node.parentId;
    while (parent) {
      if (!expanded.has(parent)) return false;
      parent = byId.get(parent)?.parentId;
    }
    return true;
  });
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const selected = visible.find((node) => node.id === selectedId);
  const relationships = architecture.relationships.filter(
    (edge) => edge.from === selectedId || edge.to === selectedId,
  );
  function select(id: string, leaveSearch = false): void {
    const ancestors = new Set(expanded);
    let parent = byId.get(id)?.parentId;
    while (parent) {
      ancestors.add(parent);
      parent = byId.get(parent)?.parentId;
    }
    setExpanded(ancestors);
    if (leaveSearch) setSearch("");
    const shown = architecture!.nodes.filter((node) => {
      if (query && !leaveSearch) return matching.has(node.id);
      let parent = node.parentId;
      while (parent) {
        if (!ancestors.has(parent)) return false;
        parent = byId.get(parent)?.parentId;
      }
      return true;
    });
    setPage(Math.floor(shown.findIndex((node) => node.id === id) / PAGE_SIZE));
    setSelectedId(id);
    requestFocus(id);
  }
  function toggle(id: string): void {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
    setSelectedId(undefined);
    setPage(0);
  }
  return (
    <div
      className="game-map game-map--canvas"
      ref={root}
      onKeyDown={(event) => {
        if (
          event.key === "/" &&
          !(event.target instanceof HTMLInputElement) &&
          !event.metaKey &&
          !event.ctrlKey
        ) {
          event.preventDefault();
          searchInput.current?.focus();
        }
      }}
    >
      <div className="game-map__floating-tools">
        <label className="game-map__search">
          <Icon name="search" size={18} />
          <span className="sr-only">Find a system</span>
          <input
            type="search"
            aria-label="Find a system"
            ref={searchInput}
            placeholder="Search this game"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setSelectedId(undefined);
              setPage(0);
            }}
          />
          {!search ? (
            <kbd aria-hidden="true">/</kbd>
          ) : (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setSearch("");
                setSelectedId(undefined);
                setPage(0);
                searchInput.current?.focus();
              }}
            >
              <Icon name="close" size={16} />
            </button>
          )}
        </label>
        <div className="game-map__view-switch" aria-label="Map display">
          <button
            type="button"
            aria-label="Show system map"
            aria-pressed={mode === "graph"}
            onClick={() => setMode("graph")}
          >
            <Icon name="graph" size={17} />
            <span>Graph</span>
          </button>
          <button
            type="button"
            aria-label="Show system list"
            aria-pressed={mode === "list"}
            onClick={() => setMode("list")}
          >
            <Icon name="details" size={17} />
            <span>List</span>
          </button>
        </div>
      </div>
      {mode === "graph" ? (
        <GameBuildCanvas
          view={view}
          filtered={[]}
          visible={[]}
          component=""
          searching={false}
          selectedId={undefined}
          onComponent={() => {}}
          onNode={() => {}}
          systems={{
            architecture,
            visibleIds: visible.map((node) => node.id),
            expandedIds: expanded,
            selectedId,
            scopeKey: `${query}:${currentPage}`,
            onSelect: select,
            onToggle: toggle,
          }}
        />
      ) : (
        <ul className="game-map__system-list" aria-label="Game systems">
          {visible.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                data-graph-node={node.id}
                aria-pressed={node.id === selectedId}
                onClick={() => select(node.id)}
              >
                {node.icon ? <span aria-hidden="true">{node.icon}</span> : <Icon name="graph" />}
                <span>
                  <strong>{node.name}</strong>
                  <small>{node.description}</small>
                </span>
              </button>
              {architecture.nodes.some((child) => child.parentId === node.id) ? (
                <button
                  type="button"
                  onClick={() => toggle(node.id)}
                  aria-label={`${expanded.has(node.id) ? "Collapse" : "Expand"} ${node.name}`}
                  aria-expanded={expanded.has(node.id)}
                >
                  {expanded.has(node.id) ? "−" : "+"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {!filtered.length ? (
        <div className="game-map__no-results" role="status">
          <Icon name="search" size={28} />
          <h3>No matching systems</h3>
          <p>Try another name or a word from its purpose.</p>
          <button
            type="button"
            onClick={() => {
              setSearch("");
              searchInput.current?.focus();
            }}
          >
            Clear search
          </button>
        </div>
      ) : null}
      {filtered.length > PAGE_SIZE ? (
        <div className="game-map__paging">
          <button
            type="button"
            aria-label="Previous systems"
            disabled={!currentPage}
            onClick={() => {
              setPage(currentPage - 1);
              setSelectedId(undefined);
              requestFocus();
            }}
          >
            ←
          </button>
          <span>
            {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)}{" "}
            of {filtered.length}
          </span>
          <button
            type="button"
            aria-label="Next systems"
            disabled={(currentPage + 1) * PAGE_SIZE >= filtered.length}
            onClick={() => {
              setPage(currentPage + 1);
              setSelectedId(undefined);
              requestFocus();
            }}
          >
            →
          </button>
        </div>
      ) : null}
      {selected ? (
        <section
          className="game-map__details"
          aria-label="Selected system details"
          key={selected.id}
        >
          <header>
            <span className="game-map__inspector-icon" aria-hidden="true">
              {selected.icon ?? <Icon name="graph" size={24} />}
            </span>
            <div>
              <span className="game-map__context">
                {selected.parentId ? byId.get(selected.parentId)!.name : architecture.name}
              </span>
              <h3>{selected.name}</h3>
            </div>
            <button
              type="button"
              aria-label="Close system details"
              onClick={() => {
                setSelectedId(undefined);
                requestFocus(selected.id);
              }}
            >
              <Icon name="close" size={16} />
            </button>
          </header>
          <p>{selected.description}</p>
          {architecture.nodes.some((node) => node.parentId === selected.id) ? (
            <div className="game-map__children">
              <h4>Inside {selected.name}</h4>
              <div>
                {architecture.nodes
                  .filter((node) => node.parentId === selected.id)
                  .map((node) => (
                    <button type="button" key={node.id} onClick={() => select(node.id, true)}>
                      {node.icon ? (
                        <span aria-hidden="true">{node.icon}</span>
                      ) : (
                        <Icon name="graph" size={17} />
                      )}
                      <span>{node.name}</span>
                      <Icon name="chevronRight" size={14} />
                    </button>
                  ))}
              </div>
            </div>
          ) : null}
          {relationships.length ? (
            <div className="game-map__relations">
              <h4>Relationships</h4>
              {relationships.map((edge) => {
                const outgoing = edge.from === selected.id;
                const other = byId.get(outgoing ? edge.to : edge.from)!;
                return (
                  <button
                    type="button"
                    key={edge.id}
                    aria-label={`${outgoing ? "To" : "From"} ${other.name}, ${edge.label}`}
                    onClick={() => select(other.id, true)}
                  >
                    <span className="game-map__relation-icon" aria-hidden="true">
                      {other.icon ?? <Icon name="graph" size={20} />}
                    </span>
                    <span>
                      <strong>{edge.label}</strong>
                      <small>
                        {outgoing ? "To" : "From"} {other.name}
                      </small>
                    </span>
                    <Icon name="chevronRight" size={15} />
                  </button>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
