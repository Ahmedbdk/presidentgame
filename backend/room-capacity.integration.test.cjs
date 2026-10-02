const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadServerHarness() {
  const serverPath = path.join(__dirname, "server.js");
  const source = `${fs.readFileSync(serverPath, "utf8")}
module.exports = {
  MAX_ROOM_CAPACITY,
  DECK_CARD_COUNT,
  ROOM_PHASES,
  rooms,
  socketRoomCodes,
  canDealEveryRoomMember,
  startNewRound,
};`;
  let ioInstance;
  const broadcasts = [];

  class MockSocketServer {
    constructor() {
      ioInstance = this;
      this.sockets = { sockets: new Map() };
      this.connectionHandler = null;
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
    makePayload(value) {
      context.__payload = JSON.stringify(value);
      return vm.runInContext("JSON.parse(__payload)", context);
    },
  };
}

function makeSocket(id) {
  const handlers = new Map();
  const emitted = [];
  const joinedRooms = new Set();

  return {
    id,
    handlers,
    emitted,
    joinedRooms,
    on(event, handler) {
      handlers.set(event, handler);
    },
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    join(roomCode) {
      joinedRooms.add(roomCode);
    },
    leave(roomCode) {
      joinedRooms.delete(roomCode);
    },
  };
}

const harness = loadServerHarness();
const {
  MAX_ROOM_CAPACITY,
  DECK_CARD_COUNT,
  ROOM_PHASES,
  rooms,
  socketRoomCodes,
  canDealEveryRoomMember,
  startNewRound,
  broadcasts,
  connect,
  makePayload,
} = harness;

function roleForPosition(position, size) {
  if (position === 1) return "President";
  if (position === size) return "Asshole";
  if (size > 4 && position === 2) return "Vice President";
  if (size > 4 && position === size - 1) return "Vice Asshole";
  return null;
}

function installRoom(size, phase = ROOM_PHASES.WAITING) {
  delete rooms.TEST;
  socketRoomCodes.clear();
  broadcasts.length = 0;

  const room = Array.from({ length: size }, (_value, index) => ({
    id: `p${index + 1}`,
    username: `Player ${index + 1}`,
    avatar: null,
    host: index === 0,
    hand: [],
    finished: phase === ROOM_PHASES.RESULTS,
    rank:
      phase === ROOM_PHASES.RESULTS
        ? roleForPosition(index + 1, size)
        : null,
    finishPosition: phase === ROOM_PHASES.RESULTS ? index + 1 : null,
    spectator: false,
  }));

  room.phase = phase;
  room.finishedPlayers =
    phase === ROOM_PHASES.RESULTS
      ? room.map((player) => ({ ...player, hand: [] }))
      : [];
  room.readyPlayers = new Set(
    phase === ROOM_PHASES.RESULTS ? room.map((player) => player.id) : [],
  );
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
  rooms.TEST = room;

  room.forEach((player) => socketRoomCodes.set(player.id, "TEST"));
  return room;
}

function emittedError(socket) {
  return socket.emitted.find(({ event }) => event === "errorMessage")?.payload;
}

assert.strictEqual(MAX_ROOM_CAPACITY, 8);
assert.strictEqual(DECK_CARD_COUNT, 52);
assert.strictEqual(canDealEveryRoomMember(Array.from({ length: 8 })), true);
assert.strictEqual(canDealEveryRoomMember(Array.from({ length: 9 })), false);

// Joining at capacity is rejected clearly without adding a seat or adapter
// membership.
{
  const room = installRoom(MAX_ROOM_CAPACITY);
  const joiner = makeSocket("p9");

  connect(joiner);
  joiner.handlers.get("joinRoom")(
    makePayload({ roomCode: "TEST", username: "Player 9" }),
  );

  assert.strictEqual(room.length, MAX_ROOM_CAPACITY);
  assert.match(emittedError(joiner), /room is full/i);
  assert.strictEqual(joiner.joinedRooms.has("TEST"), false);
  assert.strictEqual(socketRoomCodes.has(joiner.id), false);
}

// Below capacity, joining during PLAYING still creates exactly one spectator;
// replaying Join at the now-full capacity remains idempotent.
{
  const room = installRoom(MAX_ROOM_CAPACITY - 1, ROOM_PHASES.PLAYING);
  const spectator = makeSocket("p8");
  const payload = makePayload({ roomCode: "TEST", username: "Player 8" });

  connect(spectator);
  spectator.handlers.get("joinRoom")(payload);
  spectator.handlers.get("joinRoom")(payload);

  assert.strictEqual(room.length, MAX_ROOM_CAPACITY);
  assert.strictEqual(room.filter((player) => player.id === "p8").length, 1);
  assert.strictEqual(room.find((player) => player.id === "p8").spectator, true);
  assert.strictEqual(emittedError(spectator), undefined);
}

// The maximum-size initial deal includes waiting spectators, activates them,
// distributes all 52 cards, and gives every participant at least one card.
{
  const room = installRoom(MAX_ROOM_CAPACITY);
  const host = makeSocket("p1");

  room[MAX_ROOM_CAPACITY - 1].spectator = true;
  connect(host);
  host.handlers.get("startGame")("TEST");

  assert.strictEqual(room.phase, ROOM_PHASES.PLAYING);
  assert.strictEqual(room.every((player) => !player.spectator), true);
  assert.strictEqual(room.every((player) => player.hand.length > 0), true);
  assert.strictEqual(
    room.reduce((total, player) => total + player.hand.length, 0),
    DECK_CARD_COUNT,
  );
}

// A legacy/invalid oversized room is rejected before Start mutates phase or
// deals any cards.
{
  const room = installRoom(MAX_ROOM_CAPACITY + 1);
  const host = makeSocket("p1");

  connect(host);
  host.handlers.get("startGame")("TEST");

  assert.strictEqual(room.phase, ROOM_PHASES.WAITING);
  assert.strictEqual(room.every((player) => player.hand.length === 0), true);
  assert.match(emittedError(host), /room is full/i);
}

// The rematch deal has the same guard and consumes neither RESULTS nor ready
// state when an invalid oversized room is encountered.
{
  const room = installRoom(MAX_ROOM_CAPACITY + 1, ROOM_PHASES.RESULTS);

  assert.strictEqual(startNewRound("TEST"), false);
  assert.strictEqual(room.phase, ROOM_PHASES.RESULTS);
  assert.strictEqual(room.readyPlayers.size, MAX_ROOM_CAPACITY + 1);
  assert.ok(
    broadcasts.some(
      ({ target, event, payload }) =>
        target === "TEST" && event === "errorMessage" && /room is full/i.test(payload),
    ),
  );
}

// A valid maximum-size rematch still deals every member before entering the
// existing exchange flow, including a spectator who waited through the prior
// round.
{
  const room = installRoom(MAX_ROOM_CAPACITY, ROOM_PHASES.RESULTS);
  const priorRoundSize = MAX_ROOM_CAPACITY - 1;

  room[MAX_ROOM_CAPACITY - 1].spectator = true;
  room[MAX_ROOM_CAPACITY - 1].finished = false;
  room[MAX_ROOM_CAPACITY - 1].rank = null;
  room[MAX_ROOM_CAPACITY - 1].finishPosition = null;
  room.finishedPlayers = room.slice(0, priorRoundSize).map((player, index) => ({
    ...player,
    hand: [],
    rank: roleForPosition(index + 1, priorRoundSize),
    finishPosition: index + 1,
  }));

  assert.strictEqual(startNewRound("TEST"), true);
  assert.strictEqual(room.phase, ROOM_PHASES.EXCHANGE);
  assert.strictEqual(room.every((player) => !player.spectator), true);
  assert.strictEqual(room.every((player) => player.hand.length > 0), true);
  assert.strictEqual(
    room.reduce((total, player) => total + player.hand.length, 0),
    DECK_CARD_COUNT,
  );
}

console.log("Room capacity integration tests passed.");
