# Forge

Build and improve Roblox places through a conversation with an agent.

Forge connects a local dashboard to Roblox Studio. Ask for a change, review the
plan, and accept it when it is ready. Forge builds, checks, and applies the
approved changes, then replies in Markdown. Planning is read-only. Playtesting
is optional: the plugin quietly captures server diagnostics for your next message.

## Get started

You need Node.js 22+, npm, Java 11+, Rojo, Lune, `luau-compile`, `luau-lsp`, and
Roblox Studio. Set `OPENROUTER_API_KEY` in the environment used to start Forge.

```sh
npm install
npm --prefix dashboard install
npm run build:all
node bin/forge.js creator serve --default-model meta/muse-spark-1.3-contributor
```

`build:all` compiles the service and dashboard, installs the plugin at
`~/Documents/Roblox/Plugins/ForgeStudioPlugin.rbxmx`, and prepares the pinned
analysis and formal-verification tools. Restart Studio after installing the plugin.

1. Open your place in Studio and enable the plugin permissions it requests.
2. Open the one-time dashboard link printed by the service. Wait for **Studio ready**.
3. For an unlinked local place, choose **Link project**, then save the place to
   retain its project ID.
4. Send a request. Accept the proposed plan, ask for changes, or reject it.
5. After Forge finishes, inspect the result in Studio and save your work. Use
   ordinary Play and Stop whenever you want to test it; continue in the same chat.

Keep the service running while Forge works. Closing the browser does not stop an
admitted job. Restarting the service does not automatically retry interrupted work.

## Your workspace

- **Projects** follow a saved place ID, not its filename. Project and conversation
  names are editable display labels. Separate conversations keep separate context.
- **Activity** expands inline to show public progress, tool calls, elapsed time,
  requests, and reported usage. Private model reasoning is not displayed.
- **Project settings** holds preferences and send behavior. **Details** holds
  changes, checks, traces, and recovery evidence.
- **Long conversations** compact older history into a durable handoff while
  retaining the original transcript and recent messages.

The [creator guide](docs/CREATOR-EXPERIENCE.md) explains the full interaction flow.
The [orbital airlock seed](examples/orbital-freight-airlock/README.md) provides a
reproducible project and prompt for manual testing.

## How Forge protects the project

Models propose changes; the host owns approval and the plugin owns Studio writes.
Each accepted plan fixes the permitted targets and operations. The builder stages
changes virtually, and the plugin applies them through a bounded transaction with
direct readback and project-state reconciliation. Missing evidence stops the work;
it is not reported as success.

A completed edit is not a claim that the game behaves correctly. Static checks,
Studio observations, and your playtest judgments remain distinct. An optional
Rojo source adapter supports explicitly declared source roots, with one writer
per change set.

## Develop and verify

```sh
npm run format && npm run lint
npm run build && npm run plugin:build
npm test
git diff --check
```

The suite covers TypeScript, Node and dashboard behavior, browser accessibility,
plugin modules, temporary Rojo builds, pinned data, documentation, and formal
transaction models. It makes no model requests and does not operate Studio.
See [Development](docs/DEVELOPMENT.md) for prerequisites and generated-file rules.

## Documentation

| Document                                    | Purpose                                      |
| ------------------------------------------- | -------------------------------------------- |
| [Architecture](docs/ARCHITECTURE.md)        | Current components, contracts, and data flow |
| [Product principles](docs/FORGE.md)         | Scope and non-negotiable boundaries          |
| [Creator guide](docs/CREATOR-EXPERIENCE.md) | Dashboard and plugin behavior                |
| [Evaluation policy](docs/EVALS.md)          | What each kind of evidence can establish     |
| [Roadmap](docs/ROADMAP.md)                  | Next work and acceptance criteria            |
| [Research index](docs/RESEARCH.md)          | Supporting rationale and historical evidence |

Registered experiments are a separate developer workflow. They bind a seed,
model, budgets, evaluator, and implementation before execution; ordinary users
need only their place and a prompt. The [architecture guide](docs/ARCHITECTURE.md#registered-experiments)
explains that boundary. Run `node bin/forge.js` for the CLI command reference.
