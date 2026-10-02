import assert from "node:assert/strict";
import fs from "node:fs";
import {
  canSubmitSelectedPlay,
  canUsePlayControls,
  isExactSelectedPlayLegal,
  selectionExistsInHand,
} from "./src/playControlState.js";

const rankValues = {
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

const card = (rank, suit) => ({ rank, suit });
const bombElsewhere = [
  card("A", "♠"),
  card("A", "♥"),
  card("A", "♦"),
  card("A", "♣"),
];

function submit(overrides = {}) {
  return canSubmitSelectedPlay({
    roomPhase: "PLAYING",
    isPlayerPresent: true,
    isLocalTurn: true,
    isSpectator: false,
    isFinished: false,
    hand: [card("10", "♠")],
    selectedCards: [card("10", "♠")],
    tableCards: [card("9", "♥")],
    rankValues,
    ...overrides,
  });
}

assert.strictEqual(submit(), true);
assert.strictEqual(submit({ roomPhase: "RESULTS" }), false);
assert.strictEqual(submit({ roomPhase: "EXCHANGE" }), false);
assert.strictEqual(submit({ isPlayerPresent: false }), false);
assert.strictEqual(submit({ isLocalTurn: false }), false);
assert.strictEqual(submit({ isSpectator: true }), false);
assert.strictEqual(submit({ isFinished: true }), false);

assert.strictEqual(
  canUsePlayControls({
    roomPhase: "PLAYING",
    isPlayerPresent: true,
    isLocalTurn: true,
    isSpectator: false,
    isFinished: false,
  }),
  true,
);

// A selection retained from an old/replaced hand is never playable.
assert.strictEqual(
  selectionExistsInHand(
    [card("K", "♠")],
    [card("Q", "♠")],
  ),
  false,
);
assert.strictEqual(
  submit({
    hand: [card("K", "♠")],
    selectedCards: [card("Q", "♠")],
    tableCards: [],
  }),
  false,
);

// An unrelated four-Ace bomb in the hand must not legalize a lower selected
// single, pair, or triple.
for (const count of [1, 2, 3]) {
  const selectedCards = Array.from({ length: count }, (_value, index) =>
    card("7", ["♠", "♥", "♦"][index]),
  );
  const tableCards = Array.from({ length: count }, (_value, index) =>
    card("9", ["♣", "♦", "♥"][index]),
  );

  assert.strictEqual(
    submit({
      hand: [...selectedCards, ...bombElsewhere],
      selectedCards,
      tableCards,
    }),
    false,
    `lower selected ${count}-card play must remain illegal`,
  );
}

// Selecting the bomb itself remains legal, including across table counts.
assert.strictEqual(
  isExactSelectedPlayLegal(
    bombElsewhere,
    [card("K", "♠"), card("K", "♥")],
    rankValues,
  ),
  true,
);

// Exact set/count/value rules are evaluated from the selected cards only.
assert.strictEqual(
  isExactSelectedPlayLegal(
    [card("10", "♠"), card("10", "♥")],
    [card("9", "♠")],
    rankValues,
  ),
  false,
);
assert.strictEqual(
  isExactSelectedPlayLegal(
    [card("10", "♠"), card("J", "♥")],
    [],
    rankValues,
  ),
  false,
);

// Deterministically verify that every requested lifecycle/action path clears
// normal play selection in the checked-in component wiring.
const appSource = fs.readFileSync(new URL("./src/App.jsx", import.meta.url), "utf8");

function section(start, end) {
  const startIndex = appSource.indexOf(start);
  const endIndex = appSource.indexOf(end, startIndex + start.length);

  assert.notEqual(startIndex, -1, `missing ${start}`);
  assert.notEqual(endIndex, -1, `missing section end ${end}`);
  return appSource.slice(startIndex, endIndex);
}

for (const [name, source] of [
  ["replacement hand", section('socket.on("yourCards"', 'socket.on("errorMessage"')],
  ["turn loss", section('socket.on("turnUpdate"', 'socket.on("tableUpdate"')],
  ["round/new-round start", section('socket.on("gameStarted"', 'socket.on("turnUpdate"')],
  ["round end", section('socket.on("gameFinished"', "const showFinishAnnouncement")],
  ["exchange start", section('socket.on("exchangeInProgress"', 'socket.on("chooseCardRequest"')],
  ["pass", section("function passTurn()", "function playAgain()")],
  ["leave/reset", section("function leaveRoom()", "function requestLeaveRoom()")],
]) {
  assert.match(source, /setSelectedCards\(\[\]\)/, `${name} must clear selection`);
}

assert.match(
  appSource,
  /disabled=\{!canSubmitPlay\}/,
  "Play must be disabled by the exact selected-play predicate",
);
assert.match(
  appSource,
  /const canPass = playControlsEnabled && tableCards\.length > 0/,
  "Pass must require an active local turn and a non-empty table",
);
assert.match(
  appSource,
  /disabled=\{!canPass\}/,
  "Pass must be disabled when the pass predicate is false",
);

console.log("Play control-state tests passed.");
