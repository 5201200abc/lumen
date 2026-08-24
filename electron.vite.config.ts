import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const shared = resolve("src/shared");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": shared } },
    define: {
      __LUMEN_GOOGLE_CLIENT_ID__: JSON.stringify(process.env.LUMEN_GOOGLE_CLIENT_ID || "")
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": shared } }
  },
  renderer: {
    resolve: { alias: { "@": resolve("src/renderer"), "@shared": shared } },
    plugins: [react()]
  }
});
