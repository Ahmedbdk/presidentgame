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
  resolvePreviousRoundExchangeRoles,
  startNewRound,
};`;

  class MockSocketServer {
    on() {}
    to() {
      return { emit() {} };
    }
  }

  const warnings = [];
  const context = {
    module: { exports: {} },
    exports: {},
    setTimeout() { return {}; },
    clearTimeout() {},
    Set,
    Map,
    console: {
      log() {},
      error: console.error,
      warn(message) { warnings.push(message); },
    },
    require(moduleName) {
      if (moduleName === "express") return () => ({ use() {} });
      if (moduleName === "cors") return () => {};
      if (moduleName === "http") {
        return {
          createServer() {
            return { listen(_port, _host, callback) { callback?.(); } };
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

  return { ...context.module.exports, warnings };
}

const { ROOM_PHASES, rooms, startNewRound, warnings } = loadServerInternals();

function roleForPosition(position, size) {
  if (position === 1) return "President";
  if (position === size) return "Asshole";
  if (size > 4 && position === 2) return "Vice President";
  if (size > 4 && position === size - 1) return "Vice Asshole";
  return null;
}

function makeScenario(size, standingsOrder = null) {
  const room = Array.from({ length: size }, (_value, index) => ({
    id: `p${index + 1}`,
    username: `Player ${index + 1}`,
    avatar: null,
    host: index === 0,
    hand: [],
    finished: true,
    rank: roleForPosition(index + 1, size),
    finishPosition: index + 1,
    spectator: false,
  }));
  const canonicalStandings = room.map((player) => ({ ...player, hand: [] }));

  room.phase = ROOM_PHASES.RESULTS;
  room.finishedPlayers = standingsOrder
    ? standingsOrder.map((index) => canonicalStandings[index])
    : canonicalStandings;
  room.readyPlayers = new Set(room.map((player) => player.id));
  room.table = [];
  room.passedPlayerIds = new Set();
  room.currentTurnId = null;
  room.lastPlayedId = null;
  room.pendingRequest = null;
  room.exchangeQueue = [];
  room.previousAsshole = null;
  room.roundParticipantIds = Object.freeze(room.map((player) => player.id));
  room.roundParticipantCount = size;
  room.roundWithdrawals = [];

  return room;
}

function removeSeat(room, playerId) {
  const updatedRoom = room.filter((player) => player.id !== playerId);

  for (const property of [
    "phase",
    "finishedPlayers",
    "table",
    "passedPlayerIds",
    "currentTurnId",
    "lastPlayedId",
    "pendingRequest",
    "exchangeQueue",
    "previousAsshole",
    "roundParticipantIds",
    "roundParticipantCount",
    "roundWithdrawals",
  ]) {
    updatedRoom[property] = room[property];
  }

  updatedRoom.readyPlayers = new Set(updatedRoom.map((player) => player.id));
  return updatedRoom;
}

function run(room) {
  rooms.TEST = room;
  assert.strictEqual(startNewRound("TEST"), true);
  return rooms.TEST;
}

function assertStage(stage, requesterId, responderId, totalRequests) {
  assert.ok(stage);
  assert.strictEqual(stage.requesterId, requesterId);
  assert.strictEqual(stage.responderId, responderId);
  assert.strictEqual(stage.totalRequests, totalRequests);
}

// Normal four-player standings: President <-> Asshole only, one request.
{
  const room = run(makeScenario(4));
  assert.strictEqual(room.phase, ROOM_PHASES.EXCHANGE);
  assert.strictEqual(room.exchangeQueue.length, 1);
  assertStage(room.exchangeQueue[0], "p1", "p4", 1);
  assert.strictEqual(room.previousAsshole, "p4");
}

// Normal five-player standings: both mandatory pairings, in PA then VA order.
{
  const room = run(makeScenario(5));
  assert.strictEqual(room.exchangeQueue.length, 2);
  assertStage(room.exchangeQueue[0], "p1", "p5", 2);
  assertStage(room.exchangeQueue[1], "p2", "p4", 1);
}

// With six previous finishers and five remaining seats, an absent Asshole
// skips PA while the independently valid VP/VA pairing still runs.
{
  const room = run(removeSeat(makeScenario(6), "p6"));
  assert.strictEqual(room.exchangeQueue.length, 1);
  assertStage(room.exchangeQueue[0], "p2", "p5", 1);
  assert.strictEqual(room.previousAsshole, null);
}

// An absent President likewise skips PA without replacing them. The unique,
// present former Asshole remains the authoritative next-round leader.
{
  const room = run(removeSeat(makeScenario(6), "p1"));
  assert.strictEqual(room.exchangeQueue.length, 1);
  assertStage(room.exchangeQueue[0], "p2", "p5", 1);
  assert.strictEqual(room.previousAsshole, "p6");
}

// Vice-role departures skip only the VP/VA pairing; PA remains mandatory.
{
  const room = run(removeSeat(makeScenario(6), "p2"));
  assert.strictEqual(room.exchangeQueue.length, 1);
  assertStage(room.exchangeQueue[0], "p1", "p6", 2);
}

{
  const room = run(removeSeat(makeScenario(6), "p5"));
  assert.strictEqual(room.exchangeQueue.length, 1);
  assertStage(room.exchangeQueue[0], "p1", "p6", 2);
}

// An unrelated middle-ranked departure does not suppress either valid pair.
{
  const room = run(removeSeat(makeScenario(6), "p3"));
  assert.strictEqual(room.exchangeQueue.length, 2);
  assertStage(room.exchangeQueue[0], "p1", "p6", 2);
  assertStage(room.exchangeQueue[1], "p2", "p5", 1);
}

// A former Ace-Asshole may occur first chronologically in the finalized
// ledger. If they left, role order cannot make another record replace them.
{
  const room = makeScenario(5, [4, 0, 1, 2, 3]);
  const updatedRoom = run(removeSeat(room, "p5"));
  assert.strictEqual(updatedRoom.phase, ROOM_PHASES.PLAYING);
  assert.strictEqual(updatedRoom.exchangeQueue.length, 0);
  assert.strictEqual(updatedRoom.previousAsshole, null);
}

// Duplicate finalized roles are invalid, not first-match selections. Each
// independently valid pairing can still proceed.
{
  const room = makeScenario(5);
  room.finishedPlayers.push({
    ...room.finishedPlayers[0],
    id: "duplicate-president",
  });
  const updatedRoom = run(room);
  assert.strictEqual(updatedRoom.exchangeQueue.length, 1);
  assertStage(updatedRoom.exchangeQueue[0], "p2", "p4", 1);
}

{
  const room = makeScenario(5);
  room.finishedPlayers.push({
    ...room.finishedPlayers[4],
    id: "duplicate-asshole",
  });
  const updatedRoom = run(room);
  assert.strictEqual(updatedRoom.exchangeQueue.length, 1);
  assertStage(updatedRoom.exchangeQueue[0], "p2", "p4", 1);
  assert.strictEqual(updatedRoom.previousAsshole, null);
}

{
  const room = makeScenario(5);
  room.finishedPlayers.push({
    ...room.finishedPlayers[1],
    id: "duplicate-vice-president",
  });
  const updatedRoom = run(room);
  assert.strictEqual(updatedRoom.exchangeQueue.length, 1);
  assertStage(updatedRoom.exchangeQueue[0], "p1", "p5", 2);
}

// One standings ID cannot represent two different exclusive roles. Neither
// affected pairing may consume that ambiguous holder.
{
  const room = makeScenario(5);
  room.finishedPlayers[1] = {
    ...room.finishedPlayers[1],
    id: "p1",
  };
  const updatedRoom = run(room);
  assert.strictEqual(updatedRoom.phase, ROOM_PHASES.PLAYING);
  assert.strictEqual(updatedRoom.exchangeQueue.length, 0);
  assert.strictEqual(updatedRoom.previousAsshole, "p5");
}

assert.ok(
  warnings.some((message) => message.includes("finalized President standings")),
);
assert.ok(
  warnings.some((message) => message.includes("finalized Asshole standings")),
);
assert.ok(
  warnings.some((message) => message.includes("finalized Vice President standings")),
);
assert.ok(
  warnings.some((message) => message.includes("assigns exclusive roles")),
);

console.log("Exchange role-selection integration tests passed");
