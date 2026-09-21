import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import dotenv from 'dotenv';

const isProd = process.env.NODE_ENV === 'production';
const isCI = process.env.CI === 'true';

if (!isCI && !process.env.OBSIDIAN_LINE_API_URL) {
  dotenv.config({ path: '.env.local' });
}

if (isProd && !process.env.OBSIDIAN_LINE_API_URL) {
  console.warn('\x1b[33m%s\x1b[0m', `警告: 本番環境でOBSIDIAN_LINE_API_URLが設定されていません。
GitHub Actionsの環境変数でOBSIDIAN_LINE_API_URLを設定してください。`);
}

const banner =
`/*
LINE Memo Sync - generated/bundled by esbuild.
Based on LINE Notes Sync by onikun94 (MIT). See the repository for source and LICENSE.
*/
`;

const prod = (process.argv[2] === "production");


const context = await esbuild.context({
  banner: {
    js: banner,
  },
  entryPoints: ["src/main.ts"],
  bundle: true,
  define: {
    'process.env.OBSIDIAN_LINE_API_URL': JSON.stringify(process.env.OBSIDIAN_LINE_API_URL ?? ''),
    'process.env.LINE_ADD_FRIEND_URL': JSON.stringify(process.env.LINE_ADD_FRIEND_URL ?? '')
  },
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    "node:buffer",
    "node:stream",
    "node:util",
    "node:crypto",
    "node:http",
    "node:https",
    "node:url",
    "node:net",
    "node:tls",
    "node:events",
    ...builtins],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: 'main.js', 
  platform: 'node'
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}