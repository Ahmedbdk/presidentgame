const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadServerHarness() {
  const serverPath = path.join(__dirname, "server.js");
  const source = `${fs.readFileSync(serverPath, "utf8")}
module.exports = { ROOM_PHASES, rooms };`;
  let ioInstance;
  const broadcasts = [];

  class MockSocketServer {
    constructor() {
      ioInstance = this;
      this.sockets = { sockets: new Map() };
    }
    on(event, handler) {
      if (event === "connection") this.connectionHandler = handler;
    }
    to(target) {
      return {
        emit(event, payload) {
          broadcasts.push({ target, event, payload });
        },
      };
    }
    connect(socket) {
      this.sockets.sockets.set(socket.id, socket);
      this.connectionHandler(socket);
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

  return {
    ...context.module.exports,
    broadcasts,
    connect(socket) {
      ioInstance.connect(socket);
    },
  };
}

function makeSocket(id) {
  const handlers = new Map();
  const emitted = [];

  return {
    id,
    handlers,
    emitted,
    on(event, handler) {
      handlers.set(event, handler);
    },
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    join() {},
    leave() {},
  };
}

const { ROOM_PHASES, rooms, broadcasts, connect } = loadServerHarness();

function makeRoom(tableCount, size = 3) {
  const ids = ["A", "B", "C", "D"].slice(0, size);
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
  room.lastPlayedId = tableCount > 0 ? "A" : null;
  room.table = Array.from({ length: tableCount }, (_value, index) => ({
    rank: "9",
    suit: ["♠", "♥", "♦", "♣"][index],
  }));
  room.passedPlayerIds = new Set();
  room.finishedPlayers = [];
  room.pendingRequest = null;
  room.exchangeQueue = [];
  room.previousAsshole = null;
  room.readyPlayers = new Set();
  room.roundParticipantIds = Object.freeze([...ids]);
  room.roundParticipantCount = size;
  room.roundWithdrawals = [];
  rooms.TEST = room;
  broadcasts.length = 0;

  return room;
}

function pass(socket) {
  socket.handlers.get("passTurn")("TEST");
}

function errorFor(socket) {
  return socket.emitted.find(({ event }) => event === "errorMessage")?.payload;
}

// The starting player cannot pass before any card has opened the pile.
{
  const room = makeRoom(0);
  const starter = makeSocket("A");

  room.currentTurnId = "A";
  connect(starter);
  pass(starter);

  assert.match(errorFor(starter), /empty table/i);
  assert.strictEqual(room.currentTurnId, "A");
  assert.strictEqual(room.passedPlayerIds.size, 0);
}

// A pass remains legal after every supported table-play size.
for (const count of [1, 2, 3, 4]) {
  const room = makeRoom(count);
  const nextPlayer = makeSocket("B");

  connect(nextPlayer);
  pass(nextPlayer);

  assert.strictEqual(errorFor(nextPlayer), undefined);
  assert.strictEqual(room.passedPlayerIds.has("B"), true);
  assert.strictEqual(room.currentTurnId, "C");
  assert.strictEqual(room.table.length, count);
}

// Normal pass completion still clears the pile and restores the lead to the
// player who made its last play.
{
  const room = makeRoom(1);
  const playerB = makeSocket("B");
  const playerC = makeSocket("C");

  connect(playerB);
  connect(playerC);
  pass(playerB);
  pass(playerC);

  assert.strictEqual(room.table.length, 0);
  assert.strictEqual(room.passedPlayerIds.size, 0);
  assert.strictEqual(room.currentTurnId, "A");
  assert.ok(
    broadcasts.some(
      ({ target, event, payload }) =>
        target === "TEST" &&
        event === "tableUpdate" &&
        payload.table.length === 0 &&
        payload.nextPlayer === "A",
    ),
  );
}

// Finished players and spectators are rejected even if stale state points the
// current turn at them.
for (const status of ["finished", "spectator"]) {
  const room = makeRoom(1);
  const socket = makeSocket("B");

  room.find((player) => player.id === "B")[status] = true;
  connect(socket);
  pass(socket);

  assert.match(errorFor(socket), /can't pass right now/i);
  assert.strictEqual(room.passedPlayerIds.size, 0);
  assert.strictEqual(room.table.length, 1);
}

// A non-current player remains unable to pass on a non-empty pile.
{
  const room = makeRoom(1);
  const wrongPlayer = makeSocket("C");

  connect(wrongPlayer);
  pass(wrongPlayer);

  assert.match(errorFor(wrongPlayer), /not your turn/i);
  assert.strictEqual(room.passedPlayerIds.size, 0);
  assert.strictEqual(room.currentTurnId, "B");
}

console.log("Empty-table Pass integration tests passed.");
