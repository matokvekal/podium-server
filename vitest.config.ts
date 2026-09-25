import path from "node:path";
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
      // A checked-in, known-contents fixture directory — NOT the real operator-managed
      // images/PUBLIC-APP-IMAGES folder, which lives outside this repo (and outside CI's
      // checkout entirely). See config/profile-images.ts and its __fixtures__ directory.
      PROFILE_IMAGES_DIR: path.resolve(__dirname, "src/config/__fixtures__/profile-images"),
    },
  },
});
