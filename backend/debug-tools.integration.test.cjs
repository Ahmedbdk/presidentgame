const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadServerHarness(environment = {}) {
  const serverPath = path.join(__dirname, "server.js");
  const source = `${fs.readFileSync(serverPath, "utf8")}
module.exports = { ENABLE_DEBUG_TOOLS, ROOM_PHASES, rooms };`;
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
    process: { env: environment },
    Set,
    Map,
    setTimeout() { return {}; },
    clearTimeout() {},
    console: { log() {}, warn() {}, error: console.error },
    require(moduleName) {
      if (moduleName === "express") return () => ({ use() {} });
      if (moduleName === "cors") return () => {};
      if (moduleName === "crypto") return require("crypto");
      if (moduleName === "url") return require("url");
      if (moduleName === "http") {
        return {
          createServer() {
            return { listen(_port, _host, callback) { callback?.(); } };
          },
        };
      }
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

  return {
    id,
    emitted,
    on(event, handler) {
      handlers.set(event, handler);
    },
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    join() {},
    leave() {},
    send(event, payload) {
      handlers.get(event)?.(payload);
    },
    last(event) {
      return [...emitted].reverse().find((entry) => entry.event === event);
    },
  };
}

function createTwoPlayerRoom(harness) {
  const host = makeSocket("host");
  const guest = makeSocket("guest");

  harness.connect(host);
  harness.connect(guest);
  host.send(
    "createRoom",
    harness.makePayload({ username: "Host", avatar: null }),
  );

  const roomCode = host.last("roomCreated").payload.roomCode;

  guest.send(
    "joinRoom",
    harness.makePayload({ roomCode, username: "Guest", avatar: null }),
  );

  return { host, guest, roomCode, room: harness.rooms[roomCode] };
}

// Missing/false server flags are secure by default, even when a valid room
// member manually emits the otherwise-valid debug payload.
for (const environment of [{}, { ENABLE_DEBUG_TOOLS: "false" }]) {
  const harness = loadServerHarness(environment);
  const { host, roomCode, room } = createTwoPlayerRoom(harness);

  assert.strictEqual(harness.ENABLE_DEBUG_TOOLS, false);
  host.send(
    "debugBecomeRank",
    harness.makePayload({ roomCode, rank: "President" }),
  );

  assert.strictEqual(room.phase, harness.ROOM_PHASES.WAITING);
  assert.strictEqual(room[0].finished, false);
  assert.strictEqual(room[1].finished, false);
  assert.match(host.last("errorMessage").payload, /disabled/i);
  assert.strictEqual(
    harness.broadcasts.some(({ event }) => event === "gameFinished"),
    false,
  );
}

// Exact opt-in preserves the complete existing debug path, including its
// normal RESULTS -> EXCHANGE transition and exchange participant selection.
{
  const harness = loadServerHarness({ ENABLE_DEBUG_TOOLS: "true" });
  const { host, guest, roomCode, room } = createTwoPlayerRoom(harness);

  assert.strictEqual(harness.ENABLE_DEBUG_TOOLS, true);
  host.send(
    "debugBecomeRank",
    harness.makePayload({ roomCode, rank: "President" }),
  );

  assert.strictEqual(room.phase, harness.ROOM_PHASES.EXCHANGE);
  assert.strictEqual(room.finishedPlayers.length, 2);
  assert.strictEqual(room.finishedPlayers[0].rank, "President");
  assert.strictEqual(room.finishedPlayers[1].rank, "Asshole");
  assert.strictEqual(room.pendingRequest.requesterId, host.id);
  assert.strictEqual(room.pendingRequest.responderId, guest.id);
  assert(
    harness.broadcasts.some(({ event }) => event === "gameFinished"),
  );
}

console.log("debug tools integration tests passed");
