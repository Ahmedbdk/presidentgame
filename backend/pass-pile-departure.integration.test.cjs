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
  getPassedPlayerIds,
  resetPassedPlayers,
  clearPileIfAllRequiredPlayersPassed,
  removePlayerFromRoom,
};`;
  const emissions = [];

  class MockSocketServer {
    constructor() {
      this.sockets = { sockets: new Map() };
    }
    on() {}
    to(target) {
      return {
        emit(event, payload) {
          emissions.push({ target, event, payload });
        },
      };
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

  return { ...context.module.exports, emissions };
}

const {
  ROOM_PHASES,
  rooms,
  getPassedPlayerIds,
  resetPassedPlayers,
  clearPileIfAllRequiredPlayersPassed,
  removePlayerFromRoom,
  emissions,
} = loadServerInternals();

function makeRoom(ids = ["A", "B", "C", "D"]) {
  const room = ids.map((id, index) => ({
    id,
    username: id,
    avatar: null,
    host: index === 0,
    hand: [{ rank: String(index + 3), suit: "♠" }],
    finished: false,
    rank: null,
    finishPosition: null,
    spectator: false,
  }));

  room.phase = ROOM_PHASES.PLAYING;
  room.currentTurnId = "B";
  room.lastPlayedId = "A";
  room.table = [{ rank: "9", suit: "♥" }];
  room.passedPlayerIds = new Set();
  room.finishedPlayers = [];
  room.pendingRequest = null;
  room.exchangeQueue = [];
  room.previousAsshole = null;
  room.readyPlayers = new Set();
  room.roundParticipantIds = Object.freeze([...ids]);
  room.roundParticipantCount = ids.length;
  room.roundWithdrawals = [];
  rooms.TEST = room;
  emissions.length = 0;

  return room;
}

// A departed player's old pass is removed and cannot clear the pile early.
{
  const room = makeRoom();

  getPassedPlayerIds(room).add("B");
  room.currentTurnId = "C";
  removePlayerFromRoom("TEST", "B");

  const updatedRoom = rooms.TEST;

  assert.deepStrictEqual([...updatedRoom.passedPlayerIds], []);
  assert.strictEqual(updatedRoom.lastPlayedId, "A");
  assert.strictEqual(updatedRoom.table.length, 1);

  getPassedPlayerIds(updatedRoom).add("C");
  assert.strictEqual(clearPileIfAllRequiredPlayersPassed(updatedRoom), null);
  assert.strictEqual(updatedRoom.table.length, 1);

  getPassedPlayerIds(updatedRoom).add("D");
  assert.strictEqual(clearPileIfAllRequiredPlayersPassed(updatedRoom), "A");
  assert.strictEqual(updatedRoom.table.length, 0);
}

// Replaying a pass for the same player counts once and cannot replace another
// required player's opportunity.
{
  const room = makeRoom();

  getPassedPlayerIds(room).add("B");
  getPassedPlayerIds(room).add("B");

  assert.strictEqual(room.passedPlayerIds.size, 1);
  assert.strictEqual(clearPileIfAllRequiredPlayersPassed(room), null);
  assert.strictEqual(room.table.length, 1);
}

// If the actual pile owner leaves, their ID is cleared rather than reassigned.
// Every remaining active player must still pass before the pile clears.
{
  const room = makeRoom();

  room.currentTurnId = "D";
  room.passedPlayerIds = new Set(["B", "C"]);
  removePlayerFromRoom("TEST", "A");

  const updatedRoom = rooms.TEST;

  assert.strictEqual(updatedRoom.lastPlayedId, null);
  assert.strictEqual(updatedRoom.currentTurnId, "D");
  assert.strictEqual(updatedRoom.table.length, 1);

  getPassedPlayerIds(updatedRoom).add("D");
  assert.strictEqual(clearPileIfAllRequiredPlayersPassed(updatedRoom), "D");
  assert.strictEqual(updatedRoom.table.length, 0);
}

// A departure can make an already-complete set of legitimate passes complete;
// the shared removal path clears and synchronizes that pile immediately.
{
  const room = makeRoom();

  room.currentTurnId = "A";
  room.passedPlayerIds = new Set(["B", "C", "D"]);
  removePlayerFromRoom("TEST", "A");

  const updatedRoom = rooms.TEST;

  assert.strictEqual(updatedRoom.lastPlayedId, null);
  assert.strictEqual(updatedRoom.currentTurnId, "B");
  assert.strictEqual(updatedRoom.table.length, 0);
  assert.strictEqual(updatedRoom.passedPlayerIds.size, 0);
  assert.ok(
    emissions.some(
      ({ target, event, payload }) =>
        target === "TEST" &&
        event === "tableUpdate" &&
        payload.nextPlayer === "B" &&
        payload.table.length === 0,
    ),
  );
}

// Finished players and spectators are not required passers, and a normal pile
// clear still returns the lead to the player who actually made the last play.
{
  const room = makeRoom();

  room.find((player) => player.id === "C").finished = true;
  room.find((player) => player.id === "D").spectator = true;
  getPassedPlayerIds(room).add("B");

  assert.strictEqual(clearPileIfAllRequiredPlayersPassed(room), "A");
  assert.strictEqual(room.currentTurnId, "A");
  assert.strictEqual(room.table.length, 0);
}

// If the real pile owner finished on that play, preserve the established rule
// that the next eligible seat after them leads the cleared pile.
{
  const room = makeRoom();

  room.find((player) => player.id === "A").finished = true;
  room.find((player) => player.id === "D").spectator = true;
  room.currentTurnId = "C";
  room.passedPlayerIds = new Set(["B", "C"]);

  assert.strictEqual(clearPileIfAllRequiredPlayersPassed(room), "B");
  assert.strictEqual(room.currentTurnId, "B");
}

// A new play/trick starts with a fresh pass set.
{
  const room = makeRoom();

  room.passedPlayerIds = new Set(["B", "C"]);
  resetPassedPlayers(room);

  assert.strictEqual(room.passedPlayerIds.size, 0);
}

console.log("Pass/pile departure integration tests passed.");
