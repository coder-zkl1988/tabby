import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    fileParallelism: false,
    // Vitest defaults to 5s per test and 10s per hook. Both are too tight for
    // this suite, for one measured reason — and it is not a slow assertion.
    //
    // Cold dynamic import: 21 of the 85 tests/desktop files reach their subject
    // through `await import(...)` from inside a test or a hook, deliberately —
    // the module has to load after process.execPath/platform are redefined.
    // Whichever test touches a module first pays to transform its whole graph:
    // ~200ms on a dev machine, but over 5s on the windows-latest runner, where
    // that file also spent 14s in collect (2026-09-20, PR #23). It is transform
    // work, so it scales with the runner. Three of those imports sit in
    // beforeEach, which is why hookTimeout has to move with testTimeout.
    //
    // 20s is what that was observed to need on windows-latest. Suite-wide on
    // purpose: the cause is spread across 21 files, and a per-file override only
    // relocates the next argument about the number. Raise it only with a
    // measurement.
    //
    // The suite's other former cost — 38 launchd tests idling 2.6s each on
    // bootstrapWithLaunchd's real sleeps, 102s of the 122s of test time — is
    // gone: they now drive a fake clock through tests/desktop/fake-clock.ts.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/api/**"],
    setupFiles: [
      path.resolve(import.meta.dirname, "tests/setup/mock-sentry.ts"),
    ],
  },
  resolve: {
    alias: {
      "#web": path.resolve(import.meta.dirname, "apps/web/src"),
      "#desktop": path.resolve(import.meta.dirname, "apps/desktop"),
      "#controller": path.resolve(import.meta.dirname, "apps/controller/src"),
      "@": path.resolve(import.meta.dirname, "apps/web/src"),
      "@web-gen": path.resolve(import.meta.dirname, "apps/web/lib"),
      react: path.resolve(import.meta.dirname, "apps/web/node_modules/react"),
      "react/jsx-runtime": path.resolve(
        import.meta.dirname,
        "apps/web/node_modules/react/jsx-runtime.js",
      ),
      "react/jsx-dev-runtime": path.resolve(
        import.meta.dirname,
        "apps/web/node_modules/react/jsx-dev-runtime.js",
      ),
      "react-dom": path.resolve(
        import.meta.dirname,
        "apps/web/node_modules/react-dom",
      ),
      "react-router-dom": path.resolve(
        import.meta.dirname,
        "apps/web/node_modules/react-router-dom",
      ),
      "@tanstack/react-query": path.resolve(
        import.meta.dirname,
        "apps/web/node_modules/@tanstack/react-query",
      ),
    },
    dedupe: ["react", "react-dom"],
  },
});
