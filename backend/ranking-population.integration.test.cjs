const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadServerInternals() {
  const serverPath = path.join(__dirname, "server.js");
  const source = `${fs.readFileSync(serverPath, "utf8")}
module.exports = {
  ROOM_PHASES,
  rooms,
  snapshotRoundPopulation,
  assignFinisherRank,
  finishRoundIfReady,
  removePlayerFromRoom,
  startNewRound,
};`;

  class MockSocketServer {
    constructor() {
      this.sockets = { sockets: new Map() };
    }
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
    Set,
    Map,
    console: { log() {}, warn() {}, error: console.error },
    require(moduleName) {
      if (moduleName === "express") return () => ({ use() {} });
      if (moduleName === "cors") return () => {};
      if (moduleName === "http") {
        return {
          createServer() {
            return { listen(_port, callback) { callback?.(); } };
          },
        };
      }
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
  rooms,
  snapshotRoundPopulation,
  assignFinisherRank,
  finishRoundIfReady,
  removePlayerFromRoom,
  startNewRound,
} = loadServerInternals();

function makePlayingRoom(size) {
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
  room.roundParticipantIds = Object.freeze([]);
  room.roundParticipantCount = 0;
  room.roundWithdrawals = [];
  room.readyPlayers = new Set();
  room.table = [];
  room.passedPlayerIds = new Set();
  room.currentTurnId = room[0].id;
  room.lastPlayedId = null;
  room.pendingRequest = null;
  room.exchangeQueue = [];
  room.previousAsshole = null;

  snapshotRoundPopulation(room);
  rooms.TEST = room;
  return room;
}

function finishPlayer(playerId) {
  const room = rooms.TEST;
  const player = room.find((candidate) => candidate.id === playerId);

  assert.ok(player, `Expected connected player ${playerId}`);
  player.hand = [];
  assignFinisherRank(room, player, false);
  finishRoundIfReady("TEST", room);
}

function assertCanonicalStandings(room, size) {
  const standings = [...room.finishedPlayers].sort(
    (left, right) => left.finishPosition - right.finishPosition,
  );

  assert.strictEqual(standings.length, size);
  assert.deepStrictEqual(
    standings.map((player) => player.finishPosition),
    Array.from({ length: size }, (_value, index) => index + 1),
  );
  assert.strictEqual(new Set(standings.map((player) => player.id)).size, size);
  assert.strictEqual(standings.filter((player) => player.rank === "President").length, 1);
  assert.strictEqual(standings.filter((player) => player.rank === "Asshole").length, 1);

  if (size > 4) {
    assert.strictEqual(standings.filter((player) => player.rank === "Vice President").length, 1);
    assert.strictEqual(standings.filter((player) => player.rank === "Vice Asshole").length, 1);
    assert.strictEqual(standings[1].rank, "Vice President");
    assert.strictEqual(standings[size - 2].rank, "Vice Asshole");
  } else {
    assert.strictEqual(standings.some((player) => player.rank === "Vice President"), false);
    assert.strictEqual(standings.some((player) => player.rank === "Vice Asshole"), false);
  }

  assert.strictEqual(standings[0].rank, "President");
  assert.strictEqual(standings[size - 1].rank, "Asshole");
}

function assertFrozenPopulation(room, expectedIds) {
  assert.strictEqual(Object.isFrozen(room.roundParticipantIds), true);
  assert.deepStrictEqual([...room.roundParticipantIds], expectedIds);
  assert.strictEqual(room.roundParticipantCount, expectedIds.length);
}

// 1. Five-player President finishes and leaves.
{
  const room = makePlayingRoom(5);
  const originalIds = room.map((player) => player.id);
  finishPlayer("p1");
  removePlayerFromRoom("TEST", "p1");
  assertFrozenPopulation(rooms.TEST, originalIds);
  finishPlayer("p2");
  finishPlayer("p3");
  finishPlayer("p4");
  assertCanonicalStandings(rooms.TEST, 5);
  assert.strictEqual(rooms.TEST.finishedPlayers[0].id, "p1");
}

// 2. Five-player second finisher leaves.
{
  const room = makePlayingRoom(5);
  const originalIds = room.map((player) => player.id);
  finishPlayer("p1");
  finishPlayer("p2");
  removePlayerFromRoom("TEST", "p2");
  assertFrozenPopulation(rooms.TEST, originalIds);
  finishPlayer("p3");
  finishPlayer("p4");
  assertCanonicalStandings(rooms.TEST, 5);
  assert.strictEqual(
    rooms.TEST.finishedPlayers.find((player) => player.id === "p2").finishPosition,
    2,
  );
}

// 3. A finished four-player participant disconnects through the shared removal
// path. The smaller live room must not shrink the ranking denominator.
{
  const room = makePlayingRoom(4);
  const originalIds = room.map((player) => player.id);
  finishPlayer("p1");
  removePlayerFromRoom("TEST", "p1");
  assertFrozenPopulation(rooms.TEST, originalIds);
  finishPlayer("p2");
  finishPlayer("p3");
  assertCanonicalStandings(rooms.TEST, 4);
}

// 4. An unfinished departure is retained as a detached withdrawal. Genuine
// finishers keep their order; the withdrawal occupies the remaining slot
// before the natural last player, producing complete unique positions.
{
  const room = makePlayingRoom(5);
  const originalIds = room.map((player) => player.id);
  finishPlayer("p1");
  removePlayerFromRoom("TEST", "p2");
  assertFrozenPopulation(rooms.TEST, originalIds);
  assert.deepStrictEqual(
    Array.from(rooms.TEST.roundWithdrawals, (player) => player.id),
    ["p2"],
  );
  finishPlayer("p3");
  finishPlayer("p4");
  assertCanonicalStandings(rooms.TEST, 5);
  const withdrawal = rooms.TEST.finishedPlayers.find((player) => player.id === "p2");
  assert.strictEqual(withdrawal.finishPosition, 4);
  assert.strictEqual(withdrawal.rank, "Vice Asshole");
}

// 5. Baseline behavior is unchanged when nobody leaves.
{
  makePlayingRoom(5);
  finishPlayer("p1");
  finishPlayer("p2");
  finishPlayer("p3");
  finishPlayer("p4");
  assertCanonicalStandings(rooms.TEST, 5);
}

// 6/7. The next official deal replaces the prior frozen population with the
// exact current recipients and clears withdrawal metadata.
{
  const room = makePlayingRoom(5);
  finishPlayer("p1");
  removePlayerFromRoom("TEST", "p1");
  finishPlayer("p2");
  finishPlayer("p3");
  finishPlayer("p4");
  assert.strictEqual(rooms.TEST.phase, ROOM_PHASES.RESULTS);

  rooms.TEST.readyPlayers = new Set(rooms.TEST.map((player) => player.id));
  const nextRoundIds = rooms.TEST.map((player) => player.id);

  assert.strictEqual(startNewRound("TEST"), true);
  assertFrozenPopulation(rooms.TEST, nextRoundIds);
  assert.deepStrictEqual(Array.from(rooms.TEST.roundWithdrawals), []);
  assert.strictEqual(rooms.TEST.roundParticipantIds.includes("p1"), false);
}

console.log("Ranking population integration tests passed");
