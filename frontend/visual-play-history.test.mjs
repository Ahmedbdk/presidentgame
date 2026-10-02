import assert from "node:assert/strict";
import fs from "node:fs";
import {
  clearVisualPlayHistory,
  createVisualPlayHistory,
  recordVisualPlay,
  resetVisualPlayHistory,
} from "./src/visualPlayHistory.js";
import {
  advanceTableActionRevision,
  isCurrentTableActionRevision,
} from "./src/tableActionRevision.js";

const card = (rank, suit) => ({ rank, suit });
const suits = ["♠", "♥", "♦", "♣"];

function cards(rank, count) {
  return suits.slice(0, count).map((suit) => card(rank, suit));
}

function makeRapidActionHarness() {
  const history = createVisualPlayHistory();
  const revisionRef = { current: 0 };
  const pendingLandings = [];
  const state = {
    renderedGroups: [],
    discardedCards: 0,
    table: [],
    turn: null,
  };

  function play(group, nextPlayer) {
    const revision = advanceTableActionRevision(revisionRef);

    // This mirrors animation invalidation: interrupted confirmed history is
    // settled before the new group starts flying.
    state.renderedGroups = [...history.groups];
    state.table = group;
    state.turn = nextPlayer;

    const recorded = recordVisualPlay(history, group);
    if (!recorded) return;

    pendingLandings.push(() => {
      if (!isCurrentTableActionRevision(revisionRef, revision)) return;
      state.renderedGroups = [...history.groups];
    });
  }

  function clear(nextPlayer) {
    advanceTableActionRevision(revisionRef);
    state.table = [];
    state.turn = nextPlayer;

    const cleared = clearVisualPlayHistory(history);
    state.renderedGroups = [];
    state.discardedCards += cleared.cardCount;
  }

  function reset() {
    advanceTableActionRevision(revisionRef);
    resetVisualPlayHistory(history);
    state.renderedGroups = [];
    state.table = [];
    state.turn = null;
  }

  function flushAnimations() {
    pendingLandings.splice(0).forEach((callback) => callback());
  }

  return { history, state, play, clear, reset, flushAnimations };
}

// A newer play arriving before the first animation settles cannot erase the
// earlier server-confirmed group.
{
  const history = createVisualPlayHistory();
  recordVisualPlay(history, cards("7", 1));
  recordVisualPlay(history, cards("8", 1));

  assert.strictEqual(history.groups.length, 2);
  assert.deepStrictEqual(history.groups.map((group) => group[0].rank), ["7", "8"]);
}

// Pair, triple, and four-of-a-kind groups retain their exact sizes when the
// next action arrives immediately.
for (const count of [2, 3, 4]) {
  const history = createVisualPlayHistory();
  recordVisualPlay(history, cards("9", count));
  recordVisualPlay(history, cards("10", count));

  assert.deepStrictEqual(history.groups.map((group) => group.length), [count, count]);
}

// Rapid valid plays are recorded once and in arrival order. Replaying the
// same attributed group is a stale/duplicate update, not another play.
{
  const history = createVisualPlayHistory();
  const plays = [
    ["A", cards("3", 1)],
    ["B", cards("4", 1)],
    ["C", cards("5", 1)],
    ["D", cards("6", 1)],
  ];

  plays.forEach(([_playedBy, group]) => recordVisualPlay(history, group));
  assert.strictEqual(recordVisualPlay(history, cards("6", 1)), null);
  assert.strictEqual(history.groups.length, plays.length);
}

// Pile clearing consumes every recorded group exactly once. A duplicate clear
// has nothing left to count, and the next pile may record normally.
{
  const history = createVisualPlayHistory();
  recordVisualPlay(history, cards("7", 1));
  recordVisualPlay(history, cards("8", 2));
  recordVisualPlay(history, cards("9", 3));
  recordVisualPlay(history, cards("10", 4));

  const cleared = clearVisualPlayHistory(history);
  assert.strictEqual(cleared.groups.length, 4);
  assert.strictEqual(cleared.cardCount, 10);
  assert.strictEqual(clearVisualPlayHistory(history).cardCount, 0);

  assert.notStrictEqual(recordVisualPlay(history, cards("7", 1)), null);
}

// Results, Leave, and new-round resets intentionally retire the visible
// round history without allowing old animation callbacks to re-add it.
for (const scenario of ["Results", "Leave", "new round"]) {
  const history = createVisualPlayHistory();
  recordVisualPlay(history, cards("A", 1));
  resetVisualPlayHistory(history);

  assert.strictEqual(history.groups.length, 0, `${scenario} must clear history`);
  assert.strictEqual(history.recordedPlayKeys.size, 0, `${scenario} must clear dedupe keys`);
}

// A recovery snapshot has no playedBy but still provides the authoritative
// current table. It restores that visible baseline once without duplicating a
// later repeat of the same snapshot.
{
  const history = createVisualPlayHistory();
  assert.notStrictEqual(recordVisualPlay(history, cards("K", 1)), null);
  assert.strictEqual(recordVisualPlay(history, cards("K", 1)), null);
  assert.strictEqual(history.groups.length, 1);
}

// Deterministically keep the React wiring independent from animation
// completion: record before triggering flight, clear/count before animating.
const appSource = fs.readFileSync(new URL("./src/App.jsx", import.meta.url), "utf8");
const tableHandlerStart = appSource.indexOf('socket.on("tableUpdate"');
const tableHandlerEnd = appSource.indexOf('socket.on("gameFinished"', tableHandlerStart);
const tableHandler = appSource.slice(tableHandlerStart, tableHandlerEnd);

assert.ok(tableHandler.indexOf("recordVisualPlay(") < tableHandler.indexOf("animationHandlersRef.current.play"));
assert.ok(tableHandler.indexOf("clearVisualPlayHistory(") < tableHandler.indexOf("animationHandlersRef.current.clear"));
assert.match(tableHandler, /setDiscardedCardsCount\(\(previous\) => previous \+ cardCount\)/);

// Integrated rapid sequence: stale landings cannot alter authoritative state,
// while every confirmed group still contributes to the clear exactly once.
{
  const harness = makeRapidActionHarness();
  harness.play(cards("5", 1), "B");
  harness.play(cards("6", 1), "C");
  harness.play(cards("7", 1), "D");
  harness.play(cards("8", 1), "A");
  harness.play(cards("9", 1), "B");

  assert.strictEqual(harness.history.groups.length, 5);

  harness.clear("A");
  harness.flushAnimations();

  assert.deepStrictEqual(harness.state.table, []);
  assert.strictEqual(harness.state.turn, "A");
  assert.deepStrictEqual(harness.state.renderedGroups, []);
  assert.strictEqual(harness.state.discardedCards, 5);
}

// Results and Leave/reset invalidate a pending landing without allowing it to
// repaint the retired pile or authoritative table/turn projection.
for (const scenario of ["Results", "Leave/reset"]) {
  const harness = makeRapidActionHarness();
  harness.play(cards("A", 1), "B");
  harness.reset();
  harness.flushAnimations();

  assert.deepStrictEqual(harness.state.table, [], `${scenario}: table stays reset`);
  assert.strictEqual(harness.state.turn, null, `${scenario}: turn stays reset`);
  assert.deepStrictEqual(
    harness.state.renderedGroups,
    [],
    `${scenario}: stale landing stays cancelled`,
  );
}

console.log("Visual play-history tests passed.");
