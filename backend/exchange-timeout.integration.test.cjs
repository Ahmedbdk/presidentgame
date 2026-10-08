const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadHarness() {
  const serverPath = path.join(__dirname, "server.js");
  const source = `${fs.readFileSync(serverPath, "utf8")}
module.exports = {
  ROOM_PHASES,
  EXCHANGE_ACTIONS,
  EXCHANGE_ACTION_TIMEOUT_MS,
  rooms,
  disconnectTimers,
  startExchangePhase,
  handleInsufficientActivePlayers,
};`;
  let ioInstance;
  let nextTimerId = 1;
  let now = 1_000_000;
  const activeTimers = new Map();
  const allTimers = new Map();
  const broadcasts = [];

  class MockDate extends Date {
    static now() {
      return now;
    }
  }

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
      socket.ioInstance = this;
      this.connectionHandler(socket);
    }
  }

  const context = {
    module: { exports: {} },
    exports: {},
    Set,
    Map,
    Date: MockDate,
    console: { log() {}, warn() {}, error: console.error },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      const timer = { callback, delay };
      activeTimers.set(id, timer);
      allTimers.set(id, timer);
      return id;
    },
    clearTimeout(id) {
      activeTimers.delete(id);
    },
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
    activeTimers,
    connect(socket) {
      ioInstance.connect(socket);
    },
    makePayload(value) {
      context.__payload = JSON.stringify(value);
      return vm.runInContext("JSON.parse(__payload)", context);
    },
    advance(milliseconds) {
      now += milliseconds;
    },
    fireTimer(timerId, { allowCleared = false } = {}) {
      const timer = allowCleared
        ? allTimers.get(timerId)
        : activeTimers.get(timerId);
      assert(timer, `timer ${timerId} should exist`);
      activeTimers.delete(timerId);
      timer.callback();
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
    connected: true,
    on(event, handler) {
      handlers.set(event, handler);
    },
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    join() {},
    leave() {},
    disconnect() {
      if (!this.connected) return;
      this.connected = false;
      this.ioInstance?.sockets.sockets.delete(this.id);
      handlers.get("disconnect")?.();
    },
    send(event, payload, acknowledge) {
      const handler = handlers.get(event);
      assert(handler, `missing ${event} handler`);
      handler(payload, acknowledge);
    },
    last(event) {
      return [...emitted].reverse().find((entry) => entry.event === event);
    },
  };
}

const SPADES = "\u2660";
const HEARTS = "\u2665";
const DIAMONDS = "\u2666";
const CLUBS = "\u2663";

function card(rank, suit) {
  return { rank, suit };
}

function identities(room) {
  return room
    .flatMap((player) => player.hand)
    .map((value) => `${value.rank}:${value.suit}`)
    .sort();
}

function cloneHands(room) {
  return room.map((player) => player.hand.map((value) => ({ ...value })));
}

function setup({ firstRequestCount = 1 } = {}) {
  const harness = loadHarness();
  const sockets = ["requester", "responder", "vice", "vice-low"].map(
    (id) => makeSocket(id),
  );
  sockets.forEach(harness.connect);

  sockets[0].send(
    "createRoom",
    harness.makePayload({ username: "Requester", avatar: null }),
  );
  const roomCode = sockets[0].last("roomCreated").payload.roomCode;
  sockets.slice(1).forEach((socket, index) => {
    socket.send(
      "joinRoom",
      harness.makePayload({
        roomCode,
        username: `Player ${index + 2}`,
        avatar: null,
      }),
    );
  });

  const room = harness.rooms[roomCode];
  const hands = [
    [card("3", SPADES), card("4", CLUBS)],
    [card("K", HEARTS), card("5", DIAMONDS)],
    [card("8", SPADES), card("9", CLUBS)],
    [card("10", HEARTS), card("J", DIAMONDS)],
  ];

  room.forEach((player, index) => {
    player.hand = hands[index].map((value) => ({ ...value }));
    player.spectator = false;
    player.finished = false;
    player.connected = true;
  });

  const firstStage = {
    requesterId: sockets[0].id,
    requesterUsername: room[0].username,
    responderId: sockets[1].id,
    responderUsername: room[1].username,
    totalRequests: firstRequestCount,
    requestsMade: 0,
    pendingRank: null,
    awaitingReturn: false,
    pendingTransferCard: null,
  };
  const secondStage = {
    requesterId: sockets[2].id,
    requesterUsername: room[2].username,
    responderId: sockets[3].id,
    responderUsername: room[3].username,
    totalRequests: 1,
    requestsMade: 0,
    pendingRank: null,
    awaitingReturn: false,
    pendingTransferCard: null,
  };

  room.phase = harness.ROOM_PHASES.EXCHANGE;
  room.table = [];
  room.currentTurnId = null;
  room.lastPlayedId = null;
  room.finishedPlayers = [];
  room.readyPlayers = new Set();
  room.passedPlayerIds = new Set();
  room.exchangeQueue = [firstStage, secondStage];
  room.pendingRequest = null;
  harness.startExchangePhase(roomCode);

  return {
    ...harness,
    roomCode,
    room,
    sockets,
    firstStage,
    secondStage,
    tokens: sockets.map(
      (socket) => socket.last("sessionAssigned").payload.sessionToken,
    ),
  };
}

function requestKing(context) {
  context.sockets[0].send(
    "requestCardFromAsshole",
    context.makePayload({ roomCode: context.roomCode, rank: "K" }),
  );
}

function acceptKing(context) {
  context.sockets[1].send(
    "assholeRespondToRequest",
    context.makePayload({ roomCode: context.roomCode, give: true }),
  );
}

function recover(context, socket, token) {
  let result;
  context.connect(socket);
  socket.send(
    "recoverSession",
    context.makePayload({ roomCode: context.roomCode, sessionToken: token }),
    (acknowledgement) => {
      result = acknowledgement;
    },
  );
  assert.strictEqual(result.ok, true);
}

// 1/9/10. Each unanswered rank request is skipped deterministically; stages
// proceed sequentially and stale timer callbacks cannot affect newer stages.
{
  const context = setup();
  assert.strictEqual(context.EXCHANGE_ACTION_TIMEOUT_MS, 45_000);
  const firstTimer = context.room.exchangeActionTimer;
  context.fireTimer(firstTimer);
  assert.strictEqual(context.firstStage.requestsMade, 1);
  assert.strictEqual(context.room.pendingRequest, context.secondStage);
  const secondTimer = context.room.exchangeActionTimer;
  assert.notStrictEqual(secondTimer, firstTimer);

  context.fireTimer(firstTimer, { allowCleared: true });
  assert.strictEqual(context.room.pendingRequest, context.secondStage);
  assert.strictEqual(context.secondStage.requestsMade, 0);

  context.fireTimer(secondTimer);
  assert.strictEqual(context.room.phase, context.ROOM_PHASES.PLAYING);
  assert.strictEqual(context.room.pendingRequest, null);
}

// 2/5. A silent responder consumes only that request. A late response cannot
// mutate hands or commit after the fallback has issued the next rank prompt.
{
  const context = setup({ firstRequestCount: 2 });
  const beforeHands = cloneHands(context.room);
  requestKing(context);
  const responseTimer = context.room.exchangeActionTimer;
  context.fireTimer(responseTimer);
  assert.strictEqual(context.firstStage.requestsMade, 1);
  assert.strictEqual(context.room.pendingRequest, context.firstStage);
  assert.strictEqual(context.firstStage.pendingRank, null);

  context.sockets[1].send(
    "assholeRespondToRequest",
    context.makePayload({ roomCode: context.roomCode, give: true }),
  );
  assert.deepStrictEqual(
    context.room.map((player) => player.hand),
    beforeHands,
  );
  assert.strictEqual(context.firstStage.requestsMade, 1);
}

// 3/8. An unanswered return drops the pending reservation without moving a
// card, then advances the queue with all identities/counts intact.
{
  const context = setup();
  const beforeHands = cloneHands(context.room);
  const beforeIdentities = identities(context.room);
  requestKing(context);
  acceptKing(context);
  assert.strictEqual(context.firstStage.awaitingReturn, true);
  const returnTimer = context.room.exchangeActionTimer;
  context.fireTimer(returnTimer);

  assert.deepStrictEqual(
    context.room.map((player) => player.hand),
    beforeHands,
  );
  assert.deepStrictEqual(identities(context.room), beforeIdentities);
  assert.strictEqual(context.firstStage.pendingTransferCard, null);
  assert.strictEqual(context.room.pendingRequest, context.secondStage);
}

// 4. Every valid transition clears its prior timer. Even forcibly invoking a
// cleared callback cannot skip or duplicate the completed transaction.
{
  const context = setup();
  const rankTimer = context.room.exchangeActionTimer;
  requestKing(context);
  assert.strictEqual(context.activeTimers.has(rankTimer), false);
  context.fireTimer(rankTimer, { allowCleared: true });
  assert.strictEqual(context.firstStage.pendingRank, "K");

  const responseTimer = context.room.exchangeActionTimer;
  acceptKing(context);
  assert.strictEqual(context.activeTimers.has(responseTimer), false);
  const returnTimer = context.room.exchangeActionTimer;
  context.sockets[0].send(
    "returnCardToAsshole",
    context.makePayload({
      roomCode: context.roomCode,
      card: card("3", SPADES),
    }),
  );
  assert.strictEqual(context.activeTimers.has(returnTimer), false);
  const committed = identities(context.room);
  context.fireTimer(returnTimer, { allowCleared: true });
  assert.deepStrictEqual(identities(context.room), committed);
  assert.strictEqual(context.firstStage.requestsMade, 1);
}

// 6. Disconnect pauses the countdown. Recovery inside the grace period
// rebinds the participant and resumes only the unused inactivity balance.
{
  const context = setup();
  const originalTimer = context.room.exchangeActionTimer;
  context.advance(10_000);
  context.sockets[0].disconnect();
  assert.strictEqual(context.activeTimers.has(originalTimer), false);
  assert.strictEqual(context.room.exchangeActionPausedRemainingMs, 35_000);

  const recovered = makeSocket("requester-recovered");
  recover(context, recovered, context.tokens[0]);
  assert.strictEqual(context.firstStage.requesterId, recovered.id);
  assert.strictEqual(context.room.exchangeActionPausedRemainingMs, null);
  const resumedTimer = context.room.exchangeActionTimer;
  assert.strictEqual(context.activeTimers.get(resumedTimer).delay, 35_000);
  context.fireTimer(originalTimer, { allowCleared: true });
  assert.strictEqual(context.firstStage.requestsMade, 0);
  context.fireTimer(resumedTimer);
  assert.strictEqual(context.firstStage.requestsMade, 1);
}

// 7. If reconnect grace expires, normal removal cancels the involved stage;
// its paused timeout cannot later fire against the unrelated next stage.
{
  const context = setup();
  const exchangeTimer = context.room.exchangeActionTimer;
  context.sockets[0].disconnect();
  const graceTimer = context.disconnectTimers.get(context.tokens[0]);
  context.fireTimer(graceTimer);
  const liveRoom = context.rooms[context.roomCode];
  assert.strictEqual(liveRoom.pendingRequest, context.secondStage);
  context.fireTimer(exchangeTimer, { allowCleared: true });
  assert.strictEqual(liveRoom.pendingRequest, context.secondStage);
}

// 8. An authoritative WAITING reset cancels the active timer and a stale
// callback cannot pull the room back into EXCHANGE.
{
  const context = setup();
  const timer = context.room.exchangeActionTimer;
  context.room.forEach((player, index) => {
    player.spectator = index !== 0;
  });
  assert.strictEqual(
    context.handleInsufficientActivePlayers(context.roomCode, context.room),
    true,
  );
  assert.strictEqual(context.room.phase, context.ROOM_PHASES.WAITING);
  assert.strictEqual(context.activeTimers.has(timer), false);
  context.fireTimer(timer, { allowCleared: true });
  assert.strictEqual(context.room.phase, context.ROOM_PHASES.WAITING);
}

console.log("exchange timeout integration tests passed");
