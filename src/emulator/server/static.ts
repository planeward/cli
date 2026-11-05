import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** The `planeward` package root, found by walking up from this module. */
function packageRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const { name } = JSON.parse(readFileSync(manifest, "utf8")) as {
          name?: string;
        };
        if (name === "planeward") return dir;
      } catch {
        // Keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The prebuilt host UI: `dist/ui` next to the bundled `dist/bin.js`, or the
 * package's `dist/ui` when running from source.
 */
export function defaultUiDir(): string {
  const bundled = fileURLToPath(new URL("./ui/", import.meta.url));
  if (existsSync(join(bundled, "index.html"))) return bundled;
  const root = packageRoot();
  return root ? join(root, "dist", "ui") : bundled;
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Planeward emulator</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; }
  main { max-width: 32rem; line-height: 1.5; }
  code { padding: 0.1em 0.3em; border-radius: 4px; background: rgb(127 127 127 / 0.15); }
</style>
</head>
<body>
<main>
  <h1>Planeward emulator is running</h1>
  <p>The host UI isn't built. In the <code>planeward</code> CLI checkout run <code>pnpm build</code>, then reload this page.</p>
  <p>The mock API (<code>/api/v1</code>), JWKS (<code>/api/auth/jwks</code>) and webhooks work without it.</p>
</main>
</body>
</html>
`;

/** The host UI is never framed by another page (clickjacking). */
export const UI_FRAME_HEADERS = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
} as const;

/** Serves `uiDir` with an `index.html` fallback for client routes. */
export function createStaticHandler(uiDir: string) {
  const root = resolve(uiDir);
  const indexPath = join(root, "index.html");

  const sendFile = async (c: Context, path: string) => {
    const body = await readFile(path);
    const type =
      MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    const immutable = path.includes(`${sep}assets${sep}`);
    return c.body(body, 200, {
      ...UI_FRAME_HEADERS,
      "Content-Type": type,
      "Cache-Control": immutable
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    });
  };

  return async (c: Context) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.json({ error: "Not found." }, 404);
    }
    if (!existsSync(indexPath)) {
      return c.html(PLACEHOLDER_HTML, 200, UI_FRAME_HEADERS);
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.json({ error: "Not found." }, 404);
    }
    const candidate = resolve(root, `.${pathname}`);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      return c.json({ error: "Not found." }, 404);
    }
    try {
      if ((await stat(candidate)).isFile()) return sendFile(c, candidate);
    } catch {
      // Fall through to the SPA entry.
    }
    if (extname(pathname)) return c.json({ error: "Not found." }, 404);
    return sendFile(c, indexPath);
  };
}
