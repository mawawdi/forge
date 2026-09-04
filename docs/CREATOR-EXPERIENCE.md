# Forge Creator Experience

This guide describes the current dashboard and Studio plugin. It is an interaction
reference, not a second architecture specification. Start with the [README](../README.md)
for installation and [Product principles](FORGE.md) for authority boundaries.

## Open a project

Start the local Forge service and open its one-time dashboard link. The plugin
pairs the open Studio place. Wait for **Studio ready** before sending work.
An unpublished place without an ID offers **Link project**. Save the place after
linking so its `Workspace` project ID persists.

The sidebar groups conversations by project identity. A filename is only a label;
two different places may have the same name. Renaming a project or conversation
changes its display name without changing the place file or history. An unused
entry created by background pairing disappears from the workspace when another
project is opened. Explicitly linked or used projects remain.

A saved copy retains the original project ID. Use the explicit Fork action in
project settings when the copy should become a separate project. Publishing a
local place offers a continuity choice; Forge does not infer one from its name.

## Have a conversation

Each conversation has its own context. Send a goal, a question, or a follow-up in
the same chat. Forge reads the current project as needed and keeps prior decisions
and creator preferences distinct from current observations. Long chats automatically
compact older history into a durable handoff while retaining the transcript.

The composer starts small, grows as text is entered, and scrolls internally after
its height cap. The model selector stays available beside Send. Send behavior is
configurable in project settings; the interface displays the relevant shortcut.
Drafts survive ordinary navigation and reconnects in the same browser tab.

Search finds conversations, and pins keep selected chats easy to reach. Sidebar
collapse and keyboard shortcuts make room for the chat. Renaming is inline:
Enter saves and Escape cancels.

## Watch the work

Public agent commentary appears as Markdown in the conversation. A quiet activity
row summarizes the current goal and shimmers while work is active. It expands
inline into chronological tool steps; individual steps reveal the tool and target
or error details. Completed activity collapses into a compact elapsed-time summary.

Activity reports actual model/tool or host work. A pending Studio operation does
not imply another model request. Private provider reasoning and opaque continuation
are not presented as chat messages. Request count and reported usage remain
available in activity details.

The chat follows new content while the reader is at the end. Scrolling up or
expanding earlier activity preserves the reading position. Jump-to-latest and a
successful message send return to current work. Message timestamps show the time
for today and the date for older messages.

## Review a plan

Planning does not edit the place. The proposed plan shows concise steps and
optional guidance for what to inspect in Studio. Generated structural checks,
source evidence, and typed contracts are retained in Details instead of occupying
the main plan card.

Choose one of the available actions:

- **Accept plan:** build, check, and automatically apply changes within its bounds.
- **Change plan:** explain the adjustment in the conversation.
- **Reject plan:** end that proposal without editing the project.

The builder may inspect its approved context and stage changes virtually. A
completed build is not shown as applied until the host receives the required
Studio transaction evidence. The conversation presents one final Markdown result.
Source diffs and typed changes remain inspectable in Details.

## Test and continue

Save the edited place from Studio. Press ordinary Play whenever you want, exercise
the behavior, and press Stop. The plugin quietly records bounded server diagnostics
for a later follow-up. Play is optional and does not hold the conversation open,
produce repeated waiting messages, or automatically start repair.

Describe any issue in the same conversation. Report what you actually observed;
Forge keeps that judgment distinct from static analysis and captured engine facts.
A successful edit does not establish that the generated UI fits every screen or
that gameplay is correct.

## Settings and details

**Project settings** contains editable preferences, conventions, and project
controls. Preferences are creator context, not current Studio facts. Cosmetic names
are independent from this memory and from the saved project identity.

**Details** is the technical inspection surface for exact changes, source diffs,
checks, citations, artifacts, traces, usage, and recovery diagnostics. These remain
available without repeating internal identifiers and status transitions throughout
the conversation.

The plugin shows connection health and the current Studio action. It keeps the
same restrained visual direction as the dashboard while leaving conversation,
planning, and technical investigation in the browser.

## Errors and recovery

Show one readable explanation of the original failed boundary and the next valid
action. Keep the full diagnostic in Details. Do not replace a preparation failure
with a generic missing-outcome error or append duplicate failures during refresh.

A browser disconnect preserves the draft and history. If the response to an action
was lost, observe state before offering its explicit retry. Restarting the service
never silently repeats a provider request, Apply, commit, or cancellation.

Studio uncertainty blocks new work until the exact recording and receipt state
is known. Only currently authorized recovery controls are actionable. Opening a
different project leaves historical conversations readable but does not grant
write authority over the new place.

## Accessibility and presentation

Use labeled SVG icons, visible keyboard focus, readable contrast, and accessible
names for compact controls. Desktop density must not remove usable touch targets.
Drawers and dialogs support keyboard closure and focus restoration. Reduced-motion
preferences replace shimmer and animated transitions with a static presentation.

Keep project navigation, transcript, and composer visually distinct. Technical
controls belong in their dedicated surfaces, not repeated buttons on every event.
Avoid exposing internal terms such as execution slots, evidence journals, or
control-plane projections in ordinary progress prose.
