import { Children, isValidElement, memo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";
import { robloxPath, robloxPathsInText } from "../../../packages/studio-path/src/index.js";

function textContent(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? textContent(child.props.children)
        : typeof child === "string" || typeof child === "number"
          ? String(child)
          : "",
    )
    .join("");
}

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };
function displayRobloxPaths() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      // Code samples, destinations and copied code must retain their exact bytes.
      if (node.type === "code" || node.type === "link" || node.type === "image") return;
      if (node.value && node.type === "text") node.value = robloxPathsInText(node.value);
      if (node.value && node.type === "inlineCode") node.value = robloxPath(node.value);
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

const components: Components = {
  // Replies cannot load remote images or inject HTML into the dashboard.
  img: ({ alt }) => (
    <span className="message-image-label">{alt ? `[Image: ${alt}]` : "[Image]"}</span>
  ),
  a: ({ href, children }) =>
    href && /^(https?:\/\/|mailto:)/i.test(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h4>{children}</h4>,
  pre: ({ children }) => (
    <div className="message-code">
      <div className="message-code__toolbar">
        <span>Code</span>
        <CopyButton text={textContent(children)} label="Copy code" />
      </div>
      <pre tabIndex={0}>{children}</pre>
    </div>
  ),
  table: ({ children }) => (
    <div className="message-table" tabIndex={0} role="region" aria-label="Table">
      <table>{children}</table>
    </div>
  ),
};

export const RichText = memo(function RichText({
  text,
  preserveText = false,
}: {
  readonly text: string;
  readonly preserveText?: boolean;
}): React.JSX.Element {
  return (
    <div className="rich-text">
      <Markdown
        remarkPlugins={preserveText ? [remarkGfm] : [remarkGfm, displayRobloxPaths]}
        skipHtml
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
});
