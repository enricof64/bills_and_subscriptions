import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Packages the Wealthfolio 3.6+ sandbox provides at runtime — must not be bundled.
const HOST_EXTERNALS = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "lucide-react",
  "@wealthfolio/addon-sdk",
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  esbuild: {
    jsxDev: false,
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    lib: {
      entry: "src/addon.tsx",
      fileName: () => "addon.js",
      formats: ["es"],
    },
    rollupOptions: {
      external: HOST_EXTERNALS,
      output: {
        inlineDynamicImports: true,
      },
    },
    outDir: "dist",
    // Deliberately unminified. Minifying saves ~33 kB (185 kB -> 152 kB), which
    // buys nothing here: the addon is read from local disk by a desktop app, so
    // there is no transfer cost, and gzip size is irrelevant. Against that,
    // scripts/package-zip.mjs ships addon.js WITHOUT addon.js.map, so a minified
    // release would turn every user-reported stack trace into unreadable
    // one-letter frames — and host-API/quota/sync failures are exactly what
    // users report. Readable released JS is worth 33 kB of local disk.
    minify: false,
    sourcemap: true,
  },
});
