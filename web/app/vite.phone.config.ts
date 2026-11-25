// Builds the phone's web front end (phone/) into dist-phone/web, which the Android app (apps/android) packs as
// its assets and serves from https://appassets.androidplatform.net/assets/web/. Android's WebView updates with
// Chrome, so a recent Chromium is the target.
import { defineConfig } from "vite";

export default defineConfig({
  root: "phone",
  base: "./",
  worker: { format: "es" },
  build: {
    outDir: "../dist-phone/web",
    emptyOutDir: true,
    target: "chrome120",
    assetsInlineLimit: 0,
  },
});
