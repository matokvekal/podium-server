import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    env: {
      // Keep a test run readable: pino would otherwise print a full JSON line per request,
      // and trace-log a line per controller. Both are set before config/env.ts is imported.
      LOG_LEVEL: "silent",
      CONSOLE_TRACE: "false",
      NODE_ENV: "test",
      // Fixed, so URL assertions do not depend on whoever's .env is on the machine.
      PUBLIC_BASE_URL: "http://api.test.local",
    },
  },
});
