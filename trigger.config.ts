import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // Your Trigger.dev project reference (found in dashboard → Project settings).
  // Not a secret, so it lives here rather than in .env.
  project: "proj_znllkfuivbgztrmbqfov",
  // Trigger.dev tasks live here. Keep them separate from the tsx skill scripts
  // under skills/ so nothing in the existing pipeline is treated as a task.
  dirs: ["./trigger"],
  build: {
    // These packages pull in undici/node-fetch variants that break when esbuild
    // bundles them ("ProxyAgent is not a constructor"). Load from node_modules.
    external: ["apify-client", "openai", "@anthropic-ai/sdk"],
  },
  retries: {
    // No retries while developing locally so failures surface immediately.
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  maxDuration: 3600,
});
