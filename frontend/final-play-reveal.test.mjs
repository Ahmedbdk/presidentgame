import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  advanceTableActionRevision,
  isCurrentTableActionRevision,
} from "./src/tableActionRevision.js";
import {
  clearVisualPlayHistory,
  createVisualPlayHistory,
  recordVisualPlay,
  resetVisualPlayHistory,
} from "./src/visualPlayHistory.js";
import { canUsePlayControls } from "./src/playControlState.js";
import { HAND_CARD_WIDTH } from "./src/responsiveHandLayout.js";

const appSource = fs.readFileSync(new URL("./src/App.jsx", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");

function sourceFunction(name, indentation = "  ") {
  const start = appSource.indexOf(`${indentation}function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = appSource.indexOf(`\n${indentation}}\n`, start);
  assert.notEqual(end, -1, `missing end of ${name}`);
  return appSource.slice(start, end + indentation.length + 2);
}

function socketHandler(event) {
  const start = appSource.indexOf(`socket.on("${event}",`);
  assert.notEqual(start, -1, `missing ${event} handler`);
  const end = appSource.indexOf("\n    });", start);
  assert.notEqual(end, -1, `missing end of ${event} handler`);
  return appSource.slice(start, end + "\n    });".length);
}

const revealConstant = appSource.match(/const FINAL_PLAY_REVEAL_MS = (\d+);/);
assert.ok(revealConstant);
assert.equal(Number(revealConstant[1]), 3000);

const cleanupStart = appSource.indexOf("    return () => {", appSource.indexOf('socket.on("exchangeStageCancelled"'));
assert.notEqual(cleanupStart, -1);
const cleanupEnd = appSource.indexOf("\n    };", cleanupStart);
assert.notEqual(cleanupEnd, -1);
const cleanupSource = appSource.slice(cleanupStart, cleanupEnd + "\n    };".length)
  .replace("return () =>", "const unmount = () =>");

function makeHarness() {
  let elapsed = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const handlers = new Map();
  const state = {
    tableCards: [],
    playedGroups: [],
    flyingCards: [],
    clearingCards: [],
    flyingSourceKeys: new Set(),
    discardedCardsCount: 0,
    selectedCards: ["selected"],
    turnPlayerId: "local",
    myTurn: true,
    finalRankings: null,
    gameStarted: true,
  };
  const context = {
    HAND_CARD_WIDTH,
    TABLE_CARD_SPREAD: Math.round(HAND_CARD_WIDTH * 0.38),
    advanceTableActionRevision,
    isCurrentTableActionRevision,
    clearVisualPlayHistory,
    recordVisualPlay,
    resetVisualPlayHistory,
    resultsTimeoutRef: { current: null },
    roomUiEpochRef: { current: 0 },
    tableActionRevisionRef: { current: 0 },
    visualPlayHistoryRef: { current: createVisualPlayHistory() },
    animationHandlersRef: { current: {} },
    manualHandOrderRef: { current: false },
    finishAnnouncementQueueRef: { current: [] },
    finishAnnouncementTimeoutRef: { current: null },
    copyTimeoutRef: { current: null },
    pileRef: { current: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 140 }) } },
    cardRefs: { current: {} },
    fanRefs: { current: {} },
    seatRefs: { current: {} },
    myRoom: "A1B2",
    window: { localStorage: {} },
    clearPlayerSession: () => {},
    socket: {
      id: "local",
      on: (event, handler) => handlers.set(event, handler),
      off: () => handlers.clear(),
      emit: () => {},
    },
    setTimeout: (callback, delay) => {
      const timerId = nextTimerId++;
      timers.set(timerId, { callback, due: elapsed + delay });
      return timerId;
    },
    clearTimeout: (timerId) => timers.delete(timerId),
    requestAnimationFrame: (callback) => context.setTimeout(callback, 16),
  };

  for (const [, setter] of appSource.matchAll(/\b(set[A-Z]\w*)\(/g)) {
    if (setter in context) continue;
    const key = setter[3].toLowerCase() + setter.slice(4);
    context[setter] = (value) => {
      state[key] = typeof value === "function" ? value(state[key]) : value;
    };
  }

  vm.createContext(context);
  vm.runInContext([
    revealConstant[0],
    sourceFunction("groupPlacement", ""),
    sourceFunction("cardRotationInGroup", ""),
    sourceFunction("cardOffsetInGroup", ""),
    sourceFunction("invalidatePendingTableAnimations"),
    sourceFunction("triggerPlayAnimation"),
    sourceFunction("leaveRoom"),
    socketHandler("tableUpdate"),
    socketHandler("gameFinished"),
    socketHandler("gameStarted"),
    cleanupSource,
    "animationHandlersRef.current.play = triggerPlayAnimation;",
    "globalThis.unmount = unmount;",
  ].join("\n"), context);

  function advance(milliseconds) {
    const target = elapsed + milliseconds;
    for (;;) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((first, second) => first[1].due - second[1].due)[0];
      if (!next) break;
      const [timerId, timer] = next;
      elapsed = timer.due;
      timers.delete(timerId);
      timer.callback();
    }
    elapsed = target;
  }

  function emit(event, data) {
    assert.ok(handlers.has(event), `missing registered ${event}`);
    handlers.get(event)(data);
  }

  return { context, state, timers, advance, emit };
}

const finalCard = { rank: "A", suit: "spades" };
const rankings = [{ id: "winner", finishPosition: 1 }, { id: "local", finishPosition: 2 }];

function finalPlay(harness, playedBy = "winner") {
  harness.emit("tableUpdate", { table: [finalCard], playedBy, nextPlayer: "local" });
  harness.emit("gameFinished", { rankings, finalPlay: true });
}

for (const playedBy of ["winner", "local"]) {
  const harness = makeHarness();
  finalPlay(harness, playedBy);
  const revision = harness.context.tableActionRevisionRef.current;

  assert.equal(harness.state.selectedCards.length, 0);
  assert.equal(harness.state.myTurn, false);
  assert.equal(harness.state.turnPlayerId, null);
  assert.equal(harness.state.finalRankings, null);
  assert.equal(harness.state.flyingCards.length, 1);
  assert.equal(harness.state.tableCards[0].rank, "A");
  assert.equal(harness.context.visualPlayHistoryRef.current.groups.length, 1);
  assert.equal(harness.context.tableActionRevisionRef.current, revision);

  harness.advance(579);
  assert.equal(harness.state.flyingCards.length, 1);
  assert.equal(harness.state.finalRankings, null);
  harness.advance(1);
  assert.equal(harness.state.flyingCards.length, 0);
  assert.equal(harness.state.playedGroups[0][0].rank, "A");
  assert.equal(harness.state.finalRankings, null);
  harness.advance(2419);
  assert.equal(harness.state.tableCards[0].rank, "A");
  assert.equal(harness.state.playedGroups[0][0].rank, "A");
  assert.equal(harness.state.finalRankings, null);
  harness.advance(1);
  assert.strictEqual(harness.state.finalRankings, rankings);
  assert.equal(harness.state.tableCards.length, 0);
  assert.equal(harness.state.playedGroups.length, 0);
  assert.equal(harness.context.visualPlayHistoryRef.current.groups.length, 0);
  assert.equal(harness.context.resultsTimeoutRef.current, null);
}

for (const finalPlayValue of [false, undefined]) {
  const harness = makeHarness();
  harness.emit("tableUpdate", { table: [finalCard], playedBy: "winner" });
  harness.emit("gameFinished", { rankings, finalPlay: finalPlayValue });
  assert.strictEqual(harness.state.finalRankings, rankings);
  assert.equal(harness.state.tableCards.length, 0);
  assert.equal(harness.context.resultsTimeoutRef.current, null);
  harness.advance(3000);
  assert.equal(harness.state.playedGroups.length, 0);
}

for (const cancel of [
  (harness) => harness.context.invalidatePendingTableAnimations({ clearPile: true }),
  (harness) => harness.emit("gameStarted"),
  (harness) => harness.context.leaveRoom(),
  (harness) => harness.context.unmount(),
]) {
  const harness = makeHarness();
  finalPlay(harness);
  const timerId = harness.context.resultsTimeoutRef.current;
  cancel(harness);
  assert.equal(harness.context.resultsTimeoutRef.current, null);
  assert.equal(harness.timers.has(timerId), false);
  harness.advance(3000);
  assert.equal(harness.state.finalRankings, null);
  assert.equal(harness.state.playedGroups.length, 0);
}

for (const invalidate of [
  (context) => { context.roomUiEpochRef.current += 1; },
  (context) => { advanceTableActionRevision(context.tableActionRevisionRef); },
]) {
  const harness = makeHarness();
  finalPlay(harness);
  invalidate(harness.context);
  harness.advance(3000);
  assert.equal(harness.state.finalRankings, null);
  assert.equal(harness.state.tableCards[0].rank, "A");
}

{
  const harness = makeHarness();
  finalPlay(harness);
  const firstTimer = harness.context.resultsTimeoutRef.current;
  harness.advance(1000);
  const updatedRankings = [...rankings, { id: "earlier-finisher", finishPosition: 3 }];
  harness.emit("gameFinished", { rankings: updatedRankings, finalPlay: true });
  assert.equal(harness.timers.has(firstTimer), false);
  harness.advance(2000);
  assert.equal(harness.state.finalRankings, null);
  harness.advance(1000);
  assert.strictEqual(harness.state.finalRankings, updatedRankings);
}

{
  const harness = makeHarness();
  finalPlay(harness);
  harness.emit("gameFinished", { rankings });
  assert.strictEqual(harness.state.finalRankings, rankings);
  assert.equal(harness.context.resultsTimeoutRef.current, null);
  harness.advance(3000);
  assert.strictEqual(harness.state.finalRankings, rankings);
}

assert.match(appSource, /const showingFinalPlay = roomPhase === "RESULTS" && !finalRankings;/);
assert.match(appSource, /const isLivePlay =\s*roomPhase === "PLAYING" && gameStarted && !finalRankings;/);
assert.match(appSource, /const showTableView =\s*gameStarted && \(isLivePlay \|\| showingFinalPlay \|\| inExchangePhase\);/);
assert.match(appSource, /showingFinalPlay\s*\? "Round complete"/);
assert.match(appSource, /canUsePlayControls\(\{\s*roomPhase,/);
assert.equal(canUsePlayControls({ roomPhase: "RESULTS", isPlayerPresent: true, isLocalTurn: true }), false);

const roomUpdate = socketHandler("updateRoom");
assert.match(roomUpdate, /if \(!data\.roomCode\) \{[\s\S]*?invalidatePendingTableAnimations\(\{ clearPile: true \}\)/);
assert.match(roomUpdate, /if \(data\.phase === "WAITING"\) \{[\s\S]*?invalidatePendingTableAnimations\(\{ clearPile: true \}\)/);
assert.match(appSource, /const resetAfterFailedRecovery = \(\) => \{[\s\S]*?invalidatePendingTableAnimations\(\{ clearPile: true \}\)/);
assert.match(socketHandler("exchangeInProgress"), /invalidatePendingTableAnimations\(\{ clearPile: true \}\)/);

console.log("Final-play reveal tests passed.");
