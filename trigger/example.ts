import { logger, task } from "@trigger.dev/sdk";

/**
 * Foundation smoke-test task. This is NOT a production workflow — it exists only
 * to confirm the Trigger.dev dev environment is wired up correctly. Run
 * `npm run trigger:dev`, then trigger this task from the dashboard's Test page.
 */
export const helloWorld = task({
  id: "hello-world",
  run: async (payload: { name?: string }) => {
    const name = payload.name ?? "world";
    logger.info("hello-world task ran", { name });

    return {
      message: `Hello ${name}!`,
      timestamp: new Date().toISOString(),
    };
  },
});
