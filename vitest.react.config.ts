import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    css: true,
    environment: "jsdom",
    include: ["test/react/**/*.test.tsx"],
    name: "react",
    setupFiles: ["./test/react/setup.ts"],
  },
});
