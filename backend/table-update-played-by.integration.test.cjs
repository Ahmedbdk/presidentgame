const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadServerHarness() {
  const serverPath = path.join(__dirname, "server.js");
  const source = `${fs.readFileSync(serverPath, "utf8")}
module.exports = { ROOM_PHASES, rooms, rebindPlayerSocketId };`;
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

  const context = vm.createContext({
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
  });

  vm.runInContext(source, context, { filename: serverPath });

  return {
    ...context.module.exports,
    broadcasts,
    connect(socket) {
      ioInstance.connect(socket);
    },
    payload(value) {
      context.__payloadJson = JSON.stringify(value);
      return vm.runInContext("JSON.parse(__payloadJson)", context);
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
    disconnect() {},
  };
}

const {
  ROOM_PHASES,
  rooms,
  rebindPlayerSocketId,
  broadcasts,
  connect,
  payload,
} = loadServerHarness();

const suits = ["♠", "♥", "♦", "♣"];

function makeRoom(actorId = "A", playCount = 1) {
  const ids = [actorId, "B", "C"];
  const playedCards = suits.slice(0, playCount).map((suit) => ({
    rank: "9",
    suit,
  }));
  const room = ids.map((id, index) => ({
    id,
    username: id,
    avatar: null,
    host: index === 0,
    hand:
      id === actorId
        ? [...playedCards, { rank: "2", suit: "♣" }]
        : [{ rank: String(index + 3), suit: "♠" }],
    finished: false,
    rank: null,
    finishPosition: null,
    spectator: false,
    connected: true,
  }));

  room.phase = ROOM_PHASES.PLAYING;
  room.currentTurnId = actorId;
  room.lastPlayedId = null;
  room.table = [];
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
  broadcasts.length = 0;

  return { room, playedCards };
}

function play(socket, cards) {
  socket.handlers.get("playCards")(
    payload({ roomCode: "TEST", cards }),
  );
}

function pass(socket) {
  socket.handlers.get("passTurn")("TEST");
}

function tableUpdates() {
  return broadcasts.filter(
    ({ target, event }) => target === "TEST" && event === "tableUpdate",
  );
}

// A room-wide play update gives the local client its own current ID and gives
// every opponent the same authoritative opponent ID.
{
  const { playedCards } = makeRoom("A", 1);
  const playerA = makeSocket("A");
  connect(playerA);
  play(playerA, playedCards);

  const [update] = tableUpdates();
  assert.strictEqual(update.payload.playedBy, "A");
  assert.deepStrictEqual(Object.keys(update.payload).sort(), [
    "nextPlayer",
    "playedBy",
    "table",
  ]);
}

// Every supported set size keeps one attribution for the player who made the
// whole play; no card-level or private-hand data is added.
for (const playCount of [2, 3, 4]) {
  const { playedCards } = makeRoom("A", playCount);
  const playerA = makeSocket("A");
  connect(playerA);
  play(playerA, playedCards);

  const [update] = tableUpdates();
  assert.strictEqual(update.payload.playedBy, "A");
  assert.strictEqual(update.payload.table.length, playCount);
}

// Session recovery rebinds the seat to the new transport ID. The subsequent
// play must identify that current ID, which is what every client's seat map
// and the recovering client's socket now use.
{
  const { room, playedCards } = makeRoom("OLD", 1);
  const player = room.find(({ id }) => id === "OLD");
  rebindPlayerSocketId(room, player, "OLD", "NEW");

  const recoveredPlayer = makeSocket("NEW");
  connect(recoveredPlayer);
  play(recoveredPlayer, playedCards);

  const [update] = tableUpdates();
  assert.strictEqual(room.currentTurnId, "B");
  assert.strictEqual(update.payload.playedBy, "NEW");
}

// A normal pile clear is authoritative state, not a fictional card play, so
// it deliberately carries no playedBy value.
{
  const { playedCards } = makeRoom("A", 1);
  const playerA = makeSocket("A");
  const playerB = makeSocket("B");
  const playerC = makeSocket("C");
  connect(playerA);
  connect(playerB);
  connect(playerC);

  play(playerA, playedCards);
  pass(playerB);
  pass(playerC);

  const updates = tableUpdates();
  const clearUpdate = updates[updates.length - 1];
  assert.strictEqual(clearUpdate.payload.table.length, 0);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(clearUpdate.payload, "playedBy"),
    false,
  );
}

console.log("tableUpdate playedBy integration tests passed");
