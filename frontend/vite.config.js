import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// HTTPS is on by default: phone browsers only allow the camera on https pages.
// The certificate is self-signed, so the browser shows a warning once; continue past it.
// "npm run dev:http" starts without HTTPS (laptop-only use, no phone recording).
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === "http" ? [] : [basicSsl()])],
  server: {
    port: 5173,
    host: true, // reachable from a phone on the same wifi
    proxy: {
      // 127.0.0.1, not "localhost": on some machines localhost resolves to IPv6
      // while uvicorn listens on IPv4, which breaks the proxy.
      "/api": "http://127.0.0.1:8000",
    },
  },
  // "npm run demo": the built app (one small bundle), more reliable on phones than the dev server.
  preview: {
    port: 5173,
    host: true,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
}));
