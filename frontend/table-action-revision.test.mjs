import assert from "node:assert/strict";
import {
  advanceTableActionRevision,
  isCurrentTableActionRevision,
} from "./src/tableActionRevision.js";
import fs from "node:fs";

function makeHarness() {
  const revisionRef = { current: 0 };
  const pending = [];
  const state = {
    table: [],
    turn: null,
    presentation: [],
  };

  function authoritativeTableUpdate(table, turn) {
    const revision = advanceTableActionRevision(revisionRef);

    state.table = table;
    state.turn = turn;
    return revision;
  }

  function schedulePresentation(revision, cards) {
    pending.push(() => {
      if (!isCurrentTableActionRevision(revisionRef, revision)) return;
      state.presentation = cards;
    });
  }

  function invalidate(table = [], turn = null) {
    advanceTableActionRevision(revisionRef);
    state.table = table;
    state.turn = turn;
    state.presentation = [];
  }

  function flush() {
    pending.splice(0).forEach((callback) => callback());
  }

  return {
    revisionRef,
    state,
    authoritativeTableUpdate,
    schedulePresentation,
    invalidate,
    flush,
  };
}

for (const scenario of [
  { name: "play -> immediate pass -> pile clear", turn: "A" },
  { name: "play -> player leaves and pile clears", turn: "C" },
  { name: "play -> round ends", turn: null },
  { name: "play -> new round", turn: "new-starter" },
  { name: "leave room while animation is pending", turn: null },
]) {
  const harness = makeHarness();
  const playRevision = harness.authoritativeTableUpdate(["old-play"], "B");

  harness.schedulePresentation(playRevision, ["old-play"]);
  harness.invalidate([], scenario.turn);
  harness.flush();

  assert.deepEqual(
    harness.state.table,
    [],
    `${scenario.name}: table must stay cleared`,
  );
  assert.equal(
    harness.state.turn,
    scenario.turn,
    `${scenario.name}: authoritative turn must survive`,
  );
  assert.deepEqual(
    harness.state.presentation,
    [],
    `${scenario.name}: stale animation must not restore presentation`,
  );
  assert.equal(
    harness.revisionRef.current,
    2,
    `${scenario.name}: revision must advance`,
  );
}

// A leave/pass turn update that does not change the pile does not need to
// cancel the visual landing; the callback is presentation-only and therefore
// cannot overwrite the newer authoritative turn.
{
  const harness = makeHarness();
  const playRevision = harness.authoritativeTableUpdate(["play"], "B");

  harness.schedulePresentation(playRevision, ["play"]);
  harness.state.turn = "C";
  harness.flush();

  assert.deepEqual(harness.state.table, ["play"]);
  assert.equal(harness.state.turn, "C");
  assert.deepEqual(harness.state.presentation, ["play"]);
}

// The authoritative player ID supplied by normal table updates selects the
// local hand or the matching opponent seat/fan without changing animation
// timing. Empty updates continue down the clear-animation branch.
const appSource = fs.readFileSync(new URL("./src/App.jsx", import.meta.url), "utf8");

assert.match(appSource, /animationHandlersRef\.current\.play\?\.\(\s*data\.playedBy/);
assert.match(appSource, /const isMe = playedBy === socket\.id/);
assert.match(appSource, /fanRefs\.current\[playedBy\]/);
assert.match(appSource, /seatRefs\.current\[playedBy\]/);

console.log("Table action revision tests passed.");
