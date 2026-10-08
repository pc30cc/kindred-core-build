/**
 * Rollup `manualChunks` for the panel build (vite.config.ts).
 *
 * Why: the app's own code changes on every deploy, its libraries rarely do.
 * Libraries that sit in the same file as app code are downloaded again after
 * every deploy; in their own files, named by content hash, a returning
 * browser (and Cloudflare) keeps them for a year (nginx.conf.template,
 * /assets/). So third-party code is grouped into a few stable files:
 *
 *   vendor-react     react, react-dom, scheduler (+ Rollup's CJS helpers and
 *                    Vite's preload helper, which every chunk may import)
 *   vendor-router    react-router
 *   vendor-query     TanStack Query
 *   vendor-ui        Radix (shadcn/ui) and its positioning/scroll-lock
 *                    helpers, cmdk, vaul, sonner, next-themes, cva/clsx/
 *                    tailwind-merge
 *   vendor-lucide    lucide-react: the icons the app uses, tree-shaken
 *   vendor-charts    recharts + d3                         (pages with charts)
 *   vendor-date      date-fns, react-day-picker            (date pickers)
 *   vendor-forms     react-hook-form, zod, @hookform
 *   vendor-editor    TipTap / ProseMirror                  (KB article editor)
 *   vendor-maps      leaflet, react-leaflet, markercluster (visitor map)
 *   vendor-livekit   livekit-client                        (calls)
 *   vendor-brands    simple-icons                          (brand logos)
 *   vendor-misc      every OTHER library the first screen needs
 *
 * A group is downloaded only when something that needs it is opened: the
 * chart, editor and map groups never load on a page without them. Only a
 * library's OWN packages are named; its helpers (lodash, fast-equals,
 * eventemitter3, ...) are left to Rollup, which keeps a helper inside the
 * group when only that group uses it and gives it a small file of its own
 * when two do — naming fast-equals under charts made the editor download
 * all of recharts. Libraries used only by some pages and not named above
 * are likewise placed next to those pages.
 *
 * Plain JS (not TS) so the scratch measurement configs and Node can load it
 * directly; types: vendorChunks.d.mts.
 */

/** @type {ReadonlyArray<readonly [string, ReadonlyArray<string | RegExp>]>} */
const GROUPS = [
  ['vendor-react', ['react', 'react-dom', 'scheduler', 'react-is', 'use-sync-external-store']],
  ['vendor-router', ['react-router', 'react-router-dom', '@remix-run/router']],
  ['vendor-query', [/^@tanstack\//]],
  [
    'vendor-ui',
    [
      /^@radix-ui\//,
      /^@floating-ui\//,
      'react-remove-scroll',
      'react-remove-scroll-bar',
      'react-style-singleton',
      'use-callback-ref',
      'use-sidecar',
      'detect-node-es',
      'aria-hidden',
      'get-nonce',
      'cmdk',
      'vaul',
      'sonner',
      'next-themes',
      'class-variance-authority',
      'clsx',
      'tailwind-merge',
    ],
  ],
  ['vendor-lucide', ['lucide-react']],
  ['vendor-charts', ['recharts', 'recharts-scale', 'react-smooth', 'victory-vendor', /^d3-/, 'internmap', 'decimal.js-light']],
  ['vendor-date', ['date-fns', 'react-day-picker', /^date-fns-/, /^@date-fns\//]],
  ['vendor-forms', ['react-hook-form', 'zod', /^@hookform\//]],
  ['vendor-editor', [/^@tiptap\//, /^prosemirror-/, 'orderedmap', 'rope-sequence', 'w3c-keyname', 'linkifyjs']],
  ['vendor-maps', ['leaflet', 'react-leaflet', 'leaflet.markercluster', /^@react-leaflet\//]],
  ['vendor-livekit', ['livekit-client', /^@livekit\//]],
  ['vendor-brands', ['simple-icons']],
];

const NODE_MODULES = '/node_modules/';

/** `@scope/name` or `name` for a module id inside node_modules, else null. */
export function packageNameOf(id) {
  const normalized = id.replace(/\\/g, '/');
  const at = normalized.lastIndexOf(NODE_MODULES);
  if (at === -1) return null;
  const parts = normalized.slice(at + NODE_MODULES.length).split('/');
  if (!parts[0]) return null;
  return parts[0].startsWith('@') && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** The named group of a package, or null. */
export function groupOfPackage(name) {
  for (const [group, members] of GROUPS) {
    for (const member of members) {
      if (typeof member === 'string' ? member === name : member.test(name)) return group;
    }
  }
  return null;
}

/**
 * Questions about the module graph, answered once per build:
 *  - entryReachable(id): imported (statically, transitively) by an entry
 *    module, i.e. part of what the first screen downloads anyway;
 *  - usersOf(id): the groups whose packages import `id`, directly or through
 *    other unnamed library modules, plus 'app' when the app's own code does.
 */
function makeGraph(getModuleInfo) {
  const reachable = new Set();
  const entryReachable = (id, seen = new Set()) => {
    if (reachable.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const info = getModuleInfo(id);
    if (!info) return false;
    // Only a positive answer is cached; a negative one may come from a cycle
    // cut short by `seen`.
    if (info.isEntry || info.importers.some((importer) => entryReachable(importer, seen))) {
      reachable.add(id);
      return true;
    }
    return false;
  };

  const users = new Map();
  const usersOf = (id, seen = new Set()) => {
    if (users.has(id)) return users.get(id);
    const found = new Set();
    if (seen.has(id)) return found;
    seen.add(id);
    const info = getModuleInfo(id);
    for (const importer of [...(info?.importers ?? []), ...(info?.dynamicImporters ?? [])]) {
      const pkg = packageNameOf(importer);
      const group = pkg ? groupOfPackage(pkg) : null;
      if (!pkg) found.add('app');
      else if (group) found.add(group);
      else for (const user of usersOf(importer, seen)) found.add(user);
    }
    users.set(id, found);
    return found;
  };

  return { entryReachable, usersOf };
}

let graphFor = null;
let graph = null;

/** Rollup `output.manualChunks`. */
export function vendorChunk(id, meta) {
  const normalized = id.replace(/\\/g, '/');
  // Rollup's CommonJS interop helpers and Vite's dynamic-import helper: tiny,
  // stable and imported from many chunks. Kept out of the app entry so the
  // vendor files never import the entry (which would tie their hashes to it).
  if (normalized.includes('commonjsHelpers') || normalized.includes('vite/preload-helper')) return 'vendor-react';

  const name = packageNameOf(normalized);
  if (!name) return undefined;
  const group = groupOfPackage(name);
  if (group) return group;
  if (!meta || typeof meta.getModuleInfo !== 'function') return undefined;

  if (graphFor !== meta.getModuleInfo) {
    graphFor = meta.getModuleInfo;
    graph = makeGraph(meta.getModuleInfo);
  }
  // A helper the first screen needs anyway.
  if (graph.entryReachable(id)) return 'vendor-misc';
  // A helper of exactly one group travels with it. One that two groups (or a
  // group and a page) share gets a small file of its own; left to Rollup it
  // would be put inside whichever group claimed it first, and the other
  // group would then download that whole group for it.
  const usedBy = graph.usersOf(id);
  const groups = [...usedBy].filter((user) => user !== 'app');
  if (groups.length === 1 && !usedBy.has('app')) return groups[0];
  if (groups.length >= 1) return `vendor-${name.replace(/^@/, '').replace(/[^a-zA-Z0-9.-]/g, '-')}`;
  return undefined;
}
