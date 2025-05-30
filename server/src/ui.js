// The withdrawal form shown inside the chat, as an MCP App (https://github.com/modelcontextprotocol/ext-apps).
// The page is server/ui/withdraw.html with the MCP Apps SDK inlined, so the host's sandbox needs no outside
// domains. The SDK file is pinned by its hash: a changed file stops the form instead of running unknown code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { findRoot } from './paths.js';

export const UI_MIME = 'text/html;profile=mcp-app';

const SDK_FILE = 'node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js';
const SDK_SHA256 = '5bc0452b9994217df506cb505af20e97e766700513afb7d0b45d255785bb051f'; // @modelcontextprotocol/ext-apps 1.7.5
const MARKER = '/*MCP_APPS_SDK*/';

// the SDK is an ES module ending in `export{a as App,...}`: wrap it in a function of its own (its minified
// top-level names stay inside) that returns those exports as one `McpApps` object, so it can share one inline
// <script type="module"> with the form's own code
export function inlineSdk(sdk) {
  const m = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(sdk);
  if (!m) throw new Error('MCP Apps SDK: export list not found');
  const names = m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [local, as = local] = s.split(/\s+as\s+/);
    if (!/^[\w$]+$/.test(local) || !/^[\w$]+$/.test(as)) throw new Error(`MCP Apps SDK: unexpected export ${s}`);
    return `${as}:${local}`;
  });
  const body = sdk.slice(0, m.index);
  if (/(^|[^\w$.])(import|export)\s*[{*]|import\.meta/.test(body)) throw new Error('MCP Apps SDK: expected a bundle without imports');
  return `const McpApps=(()=>{\n${body}\nreturn {${names.join(',')}};\n})();\n`;
}

let cached = null;

// { uri, html }. The URI carries a hash of the page, so a host that caches resources sees a new version
// as a new resource.
export function withdrawUi({ root = findRoot() } = {}) {
  if (cached) return cached;
  const sdk = fs.readFileSync(path.join(root, SDK_FILE), 'utf8');
  const sha = crypto.createHash('sha256').update(sdk).digest('hex');
  if (sha !== SDK_SHA256) throw new Error(`the MCP Apps SDK file changed (sha256 ${sha}): check the new version, then update SDK_SHA256 in ui.js`);
  const lib = inlineSdk(sdk);
  if (/<\/script|<!--/i.test(lib)) throw new Error('MCP Apps SDK can not be inlined into a <script>');
  const page = fs.readFileSync(path.join(root, 'server', 'ui', 'withdraw.html'), 'utf8');
  if (page.split(MARKER).length !== 2) throw new Error('withdraw.html: SDK marker missing');
  const html = page.replace(MARKER, () => lib);
  const hash = crypto.createHash('sha256').update(html).digest('hex').slice(0, 12);
  cached = { uri: `ui://mcp-market/withdraw-${hash}.html`, html };
  return cached;
}
