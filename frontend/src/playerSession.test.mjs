import assert from "node:assert/strict";
import {
  PLAYER_SESSION_STORAGE_KEY,
  clearPlayerSession,
  loadPlayerSession,
  savePlayerSession,
} from "./playerSession.js";

function makeStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

const storage = makeStorage();
const session = { roomCode: "A1B2", sessionToken: "x".repeat(43) };

assert.strictEqual(savePlayerSession(storage, session), true);
assert.deepStrictEqual(loadPlayerSession(storage), session);
assert.deepStrictEqual(Object.keys(loadPlayerSession(storage)).sort(), [
  "roomCode",
  "sessionToken",
]);

storage.setItem(PLAYER_SESSION_STORAGE_KEY, "not json");
assert.strictEqual(loadPlayerSession(storage), null);
assert.strictEqual(storage.getItem(PLAYER_SESSION_STORAGE_KEY), null);

assert.strictEqual(
  savePlayerSession(storage, { roomCode: "A1B2", sessionToken: "guess" }),
  false,
);

savePlayerSession(storage, session);
clearPlayerSession(storage);
assert.strictEqual(loadPlayerSession(storage), null);

console.log("player session storage tests passed");
