import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      "/api": "http://127.0.0.1:8001",
      "/stream": "http://127.0.0.1:8001",
      "/chat": "http://127.0.0.1:8001",
      "/thumbnails": "http://127.0.0.1:8001",
      "/admin/video_feed": "http://127.0.0.1:8001",
      "/admin/detections": "http://127.0.0.1:8001",
    },
  },
  build: {
    outDir: "dist",
  },
});
