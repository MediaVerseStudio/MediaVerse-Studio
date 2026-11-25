// Builds the TV app (tv/) into dist-tv/, ready for `tizen package` (tools/package-tv.ps1). Chromium M120 is
// the web engine of 2025 Samsung TVs (Tizen 9.0); 2024 models have M108, the build target here.
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

const config = readFileSync(new URL("./tv/public/config.xml", import.meta.url), "utf8");
const version = /<widget[^>]*\sversion="([^"]+)"/.exec(config)?.[1] ?? "0.0.0";

/** Tizen opens the page from the package's own files, where module scripts can be refused; use a plain script. */
function classicScript(): Plugin {
  return {
    name: "tv-classic-script",
    apply: "build",
    enforce: "post",
    transformIndexHtml(html) {
      return html.replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g, '<script defer src="$1"></script>').replace(/ crossorigin(?=[ >])/g, "");
    },
  };
}

export default defineConfig({
  root: "tv",
  base: "./",
  define: { __TV_VERSION__: JSON.stringify(version) },
  plugins: [classicScript()],
  // The visualizer's analysis worker (tv/spectrum-thread.ts) is inlined as a plain script, like the page's own.
  worker: { format: "iife" },
  build: {
    outDir: "../dist-tv",
    emptyOutDir: true,
    target: "chrome108",
    modulePreload: false,
    assetsInlineLimit: 0,
    // One chunk with no imports or exports, so it also runs as a plain (non-module) script.
    rollupOptions: { output: { inlineDynamicImports: true, banner: "(function(){", footer: "})();" } },
  },
});
