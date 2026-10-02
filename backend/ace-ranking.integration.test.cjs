const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadRankingInternals() {
  const serverPath = path.join(__dirname, "server.js");
  const source = `${fs.readFileSync(serverPath, "utf8")}
module.exports = {
  ROOM_PHASES,
  isValidSet,
  assignFinisherRank,
  finishRoundIfReady,
  hasRoundAsshole,
};`;

  class MockSocketServer {
    on() {}
    to() {
      return { emit() {} };
    }
  }

  const context = {
    module: { exports: {} },
    exports: {},
    setTimeout() { return {}; },
    clearTimeout() {},
    console: { log() {}, error: console.error },
    require(moduleName) {
      if (moduleName === "express") {
        return () => ({ use() {} });
      }

      if (moduleName === "http") {
        return {
          createServer() {
            return { listen(_port, callback) { callback?.(); } };
          },
        };
      }

      if (moduleName === "cors") return () => {};
      if (moduleName === "crypto") return require("crypto");
      if (moduleName === "url") return require("url");
      if (moduleName === "socket.io") return { Server: MockSocketServer };

      throw new Error(`Unexpected module: ${moduleName}`);
    },
  };

  vm.runInNewContext(source, context, { filename: serverPath });
  return context.module.exports;
}

const {
  ROOM_PHASES,
  isValidSet,
  assignFinisherRank,
  finishRoundIfReady,
  hasRoundAsshole,
} = loadRankingInternals();

function makeRoom(size) {
  const room = Array.from({ length: size }, (_value, index) => ({
    id: `p${index + 1}`,
    username: `Player ${index + 1}`,
    avatar: null,
    host: index === 0,
    hand: [{}],
    finished: false,
    rank: null,
    finishPosition: null,
    spectator: false,
  }));

  room.phase = ROOM_PHASES.PLAYING;
  room.finishedPlayers = [];
  room.roundParticipantCount = size;
  room.roundParticipantIds = Object.freeze(room.map((player) => player.id));
  room.roundWithdrawals = [];
  room.readyPlayers = new Set();
  room.table = [];
  room.passedPlayerIds = new Set();
  room.currentTurnId = room[0].id;
  room.lastPlayedId = null;

  return room;
}

function finish(room, player, onAces) {
  player.hand = [];
  assignFinisherRank(room, player, onAces);
}

function assertCanonicalResults(room, size) {
  const standings = [...room.finishedPlayers].sort(
    (left, right) => left.finishPosition - right.finishPosition,
  );
  const positions = standings.map((player) => player.finishPosition);
  const roles = standings.map((player) => player.rank || "Nothing");

  assert.deepStrictEqual(positions, Array.from({ length: size }, (_v, i) => i + 1));
  assert.strictEqual(standings.filter((player) => player.rank === "President").length, 1);
  assert.strictEqual(standings.filter((player) => player.rank === "Asshole").length, 1);

  if (size > 4) {
    assert.strictEqual(standings.filter((player) => player.rank === "Vice President").length, 1);
    assert.strictEqual(standings.filter((player) => player.rank === "Vice Asshole").length, 1);
    assert.deepStrictEqual(roles, [
      "President",
      "Vice President",
      ...Array(size - 4).fill("Nothing"),
      "Vice Asshole",
      "Asshole",
    ]);
  } else {
    assert.strictEqual(standings.some((player) => player.rank === "Vice President"), false);
    assert.strictEqual(standings.some((player) => player.rank === "Vice Asshole"), false);
    assert.deepStrictEqual(roles, ["President", ...Array(size - 2).fill("Nothing"), "Asshole"]);
  }
}

function completeRound(size, aceFinisherIndexes) {
  const room = makeRoom(size);
  const firstAceFinisher = room[aceFinisherIndexes[0]];

  for (let index = 0; index < size - 1; index += 1) {
    finish(room, room[index], aceFinisherIndexes.includes(index));
  }

  assert.strictEqual(finishRoundIfReady("TEST", room), true);
  assert.strictEqual(room.phase, ROOM_PHASES.RESULTS);
  assertCanonicalResults(room, size);
  assert.strictEqual(
    room.finishedPlayers.find((player) => player.rank === "Asshole").id,
    firstAceFinisher.id,
  );
  assert.strictEqual(
    aceFinisherIndexes
      .slice(1)
      .some((index) => room[index].rank === "Asshole"),
    false,
  );
  return room;
}

for (let aceCount = 1; aceCount <= 4; aceCount += 1) {
  const cards = Array.from({ length: aceCount }, (_value, index) => ({
    rank: "A",
    suit: String(index),
  }));

  assert.strictEqual(isValidSet(cards), true, `${aceCount} Ace(s) must be a valid set`);
}

// One Ace finisher, including a later finisher rather than the first.
completeRound(5, [2]);

// Two and three distinct Ace finishers. Only the first claims Asshole.
completeRound(5, [0, 2]);
completeRound(6, [0, 1, 3]);

// Four-player role thresholds remain President/Nothing/Nothing/Asshole.
completeRound(4, [0, 1, 2]);

// The ledger retains the Ace Asshole after that seat leaves. A later Ace
// finisher ranks normally and the natural last player does not become a
// second Asshole.
{
  const originalRoom = makeRoom(5);
  const aceAsshole = originalRoom[0];

  finish(originalRoom, aceAsshole, true);
  assert.strictEqual(hasRoundAsshole(originalRoom), true);

  const room = originalRoom.filter((player) => player.id !== aceAsshole.id);
  for (const property of [
    "phase",
    "finishedPlayers",
    "roundParticipantCount",
    "roundParticipantIds",
    "roundWithdrawals",
    "readyPlayers",
    "table",
    "passedPlayerIds",
    "currentTurnId",
    "lastPlayedId",
  ]) {
    room[property] = originalRoom[property];
  }

  finish(room, room[0], true);
  finish(room, room[1], false);
  finish(room, room[2], false);

  assert.strictEqual(finishRoundIfReady("TEST", room), true);
  assertCanonicalResults(room, 5);
  assert.strictEqual(
    room.finishedPlayers.find((player) => player.rank === "Asshole").id,
    aceAsshole.id,
  );
}

console.log("Ace ranking integration tests passed");
