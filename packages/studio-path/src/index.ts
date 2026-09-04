/** Presentation only. Never use display strings to resolve or authorize an object. */
const ROOTS = new Set([
  "Workspace",
  "ReplicatedStorage",
  "ReplicatedFirst",
  "ServerScriptService",
  "ServerStorage",
  "StarterGui",
  "StarterPack",
  "StarterPlayer",
  "Lighting",
  "SoundService",
  "Teams",
  "Players",
  "TextChatService",
  "MaterialService",
  "TestService",
]);
const KEYWORDS = new Set(
  "and break do else elseif end false for function if in local nil not or repeat return then true until while".split(
    " ",
  ),
);

export function robloxPath(path: string): string {
  const [root, ...names] = path.split("/");
  if (
    !root ||
    !ROOTS.has(root) ||
    !names.length ||
    names.some((name) => !name || name === "." || name === "..")
  )
    return path;
  return (
    root +
    names
      .map((name) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !KEYWORDS.has(name)
          ? `.${name}`
          : `[${JSON.stringify(name)}]`,
      )
      .join("")
  );
}

/** Bare paths in prose; quoted names with spaces are formatted as complete inline code spans. */
export function robloxPathsInText(text: string): string {
  return text.replace(
    /(?<![\w/\\.:])(?:Workspace|ReplicatedStorage|ReplicatedFirst|ServerScriptService|ServerStorage|StarterGui|StarterPack|StarterPlayer|Lighting|SoundService|Teams|Players|TextChatService|MaterialService|TestService)(?:\/[\p{L}\p{N}_][\p{L}\p{N}_.-]*)+/gu,
    (path) => {
      const suffix = path.match(/[.,]+$/)?.[0] ?? "";
      return robloxPath(suffix ? path.slice(0, -suffix.length) : path) + suffix;
    },
  );
}
