import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      "/api": "http://127.0.0.1:8002",
      "/stream": "http://127.0.0.1:8002",
      "/chat": "http://127.0.0.1:8002",
      "/thumbnails": "http://127.0.0.1:8002",
      "/admin/video_feed": "http://127.0.0.1:8002",
      "/admin/detections": "http://127.0.0.1:8002",
    },
  },
  build: {
    outDir: "dist",
  },
});
