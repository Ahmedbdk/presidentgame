import assert from "node:assert/strict";
import fs from "node:fs";
import { getSessionRecoveryUiState } from "./src/sessionRecoveryUi.js";

function uiState(overrides = {}) {
  return getSessionRecoveryUiState({
    roomCode: "A1B2",
    sessionReady: true,
    socketConnected: true,
    ...overrides,
  });
}

// The same visible reconnecting state is used in every room phase. The phase
// itself stays authoritative and untouched behind the presentation overlay.
for (const phase of ["WAITING", "PLAYING", "RESULTS", "EXCHANGE"]) {
  assert.deepStrictEqual(
    uiState({ sessionReady: false }),
    { isReconnecting: true, interactionsEnabled: false },
    `${phase}: recovery-pending sessions must block interactions`,
  );
}

assert.deepStrictEqual(
  uiState({ socketConnected: false }),
  { isReconnecting: true, interactionsEnabled: false },
  "a dropped transport must show the reconnecting state",
);

assert.deepStrictEqual(
  uiState({ sessionReady: false, socketConnected: true }),
  { isReconnecting: true, interactionsEnabled: false },
  "a reconnected socket must stay blocked until session recovery succeeds",
);

assert.deepStrictEqual(
  uiState(),
  { isReconnecting: false, interactionsEnabled: true },
  "successful recovery must restore interactions",
);

assert.deepStrictEqual(
  uiState({ roomCode: "", sessionReady: true }),
  { isReconnecting: false, interactionsEnabled: true },
  "failed or expired recovery must not leave an overlay on Create / Join",
);

assert.deepStrictEqual(
  uiState({ roomCode: "", sessionReady: false }),
  { isReconnecting: false, interactionsEnabled: false },
  "an initial stored-session recovery has no stale table overlay",
);

// Keep deterministic wiring checks for the server-emitting actions. The
// overlay is a visual/input barrier, while these guards remain the final
// client-side protection against keyboard or stale-event activation.
const appSource = fs.readFileSync(new URL("./src/App.jsx", import.meta.url), "utf8");

for (const action of [
  "playCards",
  "passTurn",
  "playAgain",
  "requestCard",
  "respondToRequest",
  "returnCard",
]) {
  const start = appSource.indexOf(`function ${action}(`);
  const end = appSource.indexOf("\n  }", start);
  assert.notEqual(start, -1, `missing ${action}`);
  assert.match(
    appSource.slice(start, end),
    /if \(!sessionInteractionsEnabled\) return;/,
    `${action} must reject submission while recovery is pending`,
  );
}

assert.match(appSource, /className="reconnecting-layer"/);
assert.match(appSource, />Reconnecting\.\.\.<\/strong>/);

console.log("Session recovery UI tests passed.");
