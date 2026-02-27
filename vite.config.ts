import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error mode is a valid runtime option not yet typed
  plugins: [react(), cloudflare({ mode: "local" }), tailwindcss()]
});
