import assert from "node:assert/strict";
import { resolveSocketUrl } from "./socketConfig.js";
import viteConfig from "../vite.config.js";

assert.strictEqual(
  resolveSocketUrl({ configuredUrl: undefined }),
  null,
);

assert.strictEqual(
  resolveSocketUrl({
    configuredUrl: "  https://api.example.com  ",
  }),
  "https://api.example.com",
);

assert.strictEqual(
  resolveSocketUrl({ configuredUrl: "" }),
  null,
);

assert.strictEqual(
  viteConfig.server.proxy["/socket.io"].target,
  "http://localhost:3001",
);
assert.strictEqual(viteConfig.server.proxy["/socket.io"].ws, true);

console.log("socket configuration tests passed");
