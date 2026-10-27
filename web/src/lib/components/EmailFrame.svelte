<script lang="ts" module>
  const REMOTE_RE = /(?:src|background|poster)\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:/i;
  const STYLED_RE = /bgcolor\s*=|background(?:-color)?\s*:|<font[^>]+color|(?:^|[^-\w])color\s*:/i;

  export function hasRemoteContent(html: string): boolean {
    return REMOTE_RE.test(html);
  }
</script>

<script lang="ts">
  let { html, inlineOrigins = [], allowRemote = false, dark = false, onmailto }: {
    html: string;
    /** Origins of presigned URLs for cid: images, allowed even when remote content is blocked */
    inlineOrigins?: string[];
    allowRemote?: boolean;
    dark?: boolean;
    onmailto?: (href: string) => void;
  } = $props();

  let iframe = $state<HTMLIFrameElement>();
  let height = $state(120);

  // Mail that sets its own colors is designed for a light background; forcing dark breaks it.
  let darkSafe = $derived(dark && !STYLED_RE.test(html));

  let srcdoc = $derived.by(() => {
    const remote = allowRemote ? " https: http:" : "";
    const csp = [
      "default-src 'none'",
      `img-src data: ${inlineOrigins.join(" ")}${remote}`,
      `style-src 'unsafe-inline'${remote}`,
      `font-src data:${remote}`,
      `media-src data:${remote}`,
    ].join("; ");
    const fg = darkSafe ? "#e4e6f1" : "#1d2029";
    const style = `<style>
      html, body { margin: 0; padding: 0; }
      body { padding: 16px; font: 15px/1.55 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
        color: ${fg}; background: ${darkSafe ? "transparent" : "#fff"}; overflow-wrap: break-word; }
      a { color: ${darkSafe ? "#8f9cff" : "#3d4fd1"}; }
      img:not([height]) { max-width: 100%; height: auto; }
      pre { white-space: pre-wrap; }
      blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid ${darkSafe ? "#3a4058" : "#d5d9e6"}; }
    </style>`;
    return `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
      `<meta name="referrer" content="no-referrer"><base target="_blank">${style}</head><body>${html}</body></html>`;
  });

  let fittedWidth = 0;

  function measure() {
    const doc = iframe?.contentDocument;
    if (!doc?.body) return;
    const width = iframe!.clientWidth;
    if (width !== fittedWidth) {
      fittedWidth = width;
      doc.body.style.zoom = "";
      const contentWidth = doc.documentElement.scrollWidth;
      if (contentWidth > width + 1) doc.body.style.zoom = String(width / contentWidth);
    }
    height = Math.max(60, Math.ceil(doc.documentElement.scrollHeight));
  }

  function onload() {
    const doc = iframe?.contentDocument;
    if (!doc) return;
    fittedWidth = 0;
    measure();
    doc.querySelectorAll("img").forEach(img => img.addEventListener("load", measure));
    doc.addEventListener("click", e => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (a && a.href.toLowerCase().startsWith("mailto:") && onmailto) {
        e.preventDefault();
        onmailto(a.href);
      }
    });
    observer?.disconnect();
    observer = new ResizeObserver(measure);
    observer.observe(doc.body);
  }

  let observer: ResizeObserver | undefined;

  $effect(() => {
    if (!iframe) return;
    const outer = new ResizeObserver(() => { if (iframe!.clientWidth !== fittedWidth) measure(); });
    outer.observe(iframe);
    return () => { outer.disconnect(); observer?.disconnect(); };
  });
</script>

<div class="frame" class:paper={!darkSafe}>
  <iframe
    bind:this={iframe}
    title="Message body"
    {srcdoc}
    {onload}
    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    style:height="{height}px"
  ></iframe>
</div>

<style>
  .frame { border-radius: var(--radius); overflow: hidden; }
  .frame.paper { background: #fff; box-shadow: inset 0 0 0 1px var(--border); }
  iframe {
    display: block;
    width: 100%;
    border: none;
    background: transparent;
    color-scheme: normal;
  }
  :global([data-theme="dark"]) .frame:not(.paper) iframe { color-scheme: dark; }
</style>
