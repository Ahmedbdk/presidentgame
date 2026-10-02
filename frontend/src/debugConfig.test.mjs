import assert from "node:assert/strict";
import { isDebugToolsEnabled } from "./debugConfig.js";

assert.strictEqual(isDebugToolsEnabled(undefined), false);
assert.strictEqual(isDebugToolsEnabled(""), false);
assert.strictEqual(isDebugToolsEnabled("false"), false);
assert.strictEqual(isDebugToolsEnabled("TRUE"), false);
assert.strictEqual(isDebugToolsEnabled(true), false);
assert.strictEqual(isDebugToolsEnabled("true"), true);

console.log("debug configuration tests passed");
