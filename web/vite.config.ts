import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server proxies API + WebSocket traffic to the Bun server so the
// browser talks to a single origin. `bun run dev` at the repo root starts
// both; OMP_WEB_PORT must match server/src/config.ts's default.
const serverPort = process.env.OMP_WEB_PORT ?? "7367";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		port: 5173,
		proxy: {
			"/api": { target: `http://localhost:${serverPort}`, changeOrigin: true },
			"/ws": { target: `ws://localhost:${serverPort}`, ws: true },
		},
	},
	build: {
		outDir: "dist",
		sourcemap: true,
	},
});
