import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  define: {
    __RT22_D1_MIGRATIONS__: JSON.stringify(migrations),
  },
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          ADMIN_PASSWORD: "vitest-only-admin-password",
        },
      },
    }),
  ],
  test: {
    include: ["test/worker/**/*.test.ts"],
    name: "worker",
  },
});
