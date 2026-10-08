const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadHarness() {
  const serverPath = path.join(__dirname, "server.js");
  const source = `${fs.readFileSync(serverPath, "utf8")}
module.exports = {
  ROOM_PHASES,
  rooms,
  disconnectTimers,
};`;
  let ioInstance;
  let nextTimerId = 1;
  const timers = new Map();
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
      socket.ioInstance = this;
      this.connectionHandler(socket);
    }
  }

  const context = {
    module: { exports: {} },
    exports: {},
    Set,
    Map,
    console: { log() {}, warn() {}, error: console.error },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
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
    timers,
    connect(socket) {
      ioInstance.connect(socket);
    },
    makePayload(value) {
      context.__payload = JSON.stringify(value);
      return vm.runInContext("JSON.parse(__payload)", context);
    },
    runTimer(timerId) {
      const timer = timers.get(timerId);
      assert(timer, `timer ${timerId} should exist`);
      timers.delete(timerId);
      timer.callback();
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
    connected: true,
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

function card(rank, suit) {
  return { rank, suit };
}

const SPADES = "\u2660";
const HEARTS = "\u2665";
const DIAMONDS = "\u2666";
const CLUBS = "\u2663";

function identity(cardValue) {
  return `${cardValue.rank}:${cardValue.suit}`;
}

function roomCardIdentities(room) {
  return room
    .flatMap((player) => player.hand.map(identity))
    .sort();
}

function cloneHands(room) {
  return room.map((player) => player.hand.map((value) => ({ ...value })));
}

function assertHandsEqual(room, expected) {
  assert.deepStrictEqual(
    room.map((player) => player.hand),
    expected,
  );
}

function setupTransaction() {
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
    totalRequests: 1,
    requestsMade: 0,
    pendingRank: null,
    awaitingReturn: false,
    pendingTransferCard: null,
  };
  const nextStage = {
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
  room.exchangeQueue = [firstStage, nextStage];
  room.pendingRequest = firstStage;

  return {
    ...harness,
    roomCode,
    room,
    sockets,
    firstStage,
    nextStage,
    tokens: sockets.map(
      (socket) => socket.last("sessionAssigned").payload.sessionToken,
    ),
  };
}

function acceptRequestedKing(context) {
  const { sockets, makePayload, roomCode } = context;
  sockets[0].send(
    "requestCardFromAsshole",
    makePayload({ roomCode, rank: "K" }),
  );
  sockets[1].send(
    "assholeRespondToRequest",
    makePayload({ roomCode, give: true }),
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

// 1/6/7/8/9. Normal commit is atomic, invalid and duplicate returns are
// harmless, identities/counts are conserved, and the queue advances once.
{
  const context = setupTransaction();
  const beforeHands = cloneHands(context.room);
  const beforeIdentities = roomCardIdentities(context.room);
  acceptRequestedKing(context);

  assertHandsEqual(context.room, beforeHands);
  assert.strictEqual(context.firstStage.awaitingReturn, true);
  assert.strictEqual(
    identity(context.firstStage.pendingTransferCard),
    `K:${HEARTS}`,
  );

  const promptsBeforeInvalid = context.broadcasts.filter(
    (entry) =>
      entry.target === context.sockets[0].id &&
      entry.event === "chooseCardToReturn",
  ).length;
  context.sockets[0].send(
    "returnCardToAsshole",
    context.makePayload({ roomCode: context.roomCode, card: card("A", SPADES) }),
  );
  assertHandsEqual(context.room, beforeHands);
  assert.strictEqual(context.firstStage.awaitingReturn, true);
  assert.strictEqual(
    context.broadcasts.filter(
      (entry) =>
        entry.target === context.sockets[0].id &&
        entry.event === "chooseCardToReturn",
    ).length,
    promptsBeforeInvalid + 1,
  );

  const returnPayload = context.makePayload({
    roomCode: context.roomCode,
    card: card("3", SPADES),
  });
  context.sockets[0].send("returnCardToAsshole", returnPayload);

  assert.deepStrictEqual(roomCardIdentities(context.room), beforeIdentities);
  assert.strictEqual(
    context.room.reduce((total, player) => total + player.hand.length, 0),
    8,
  );
  assert(
    context.room[0].hand.some(
      (value) => identity(value) === `K:${HEARTS}`,
    ),
  );
  assert(
    context.room[1].hand.some(
      (value) => identity(value) === `3:${SPADES}`,
    ),
  );
  assert.strictEqual(context.firstStage.awaitingReturn, false);
  assert.strictEqual(context.firstStage.pendingTransferCard, null);
  assert.strictEqual(context.firstStage.requestsMade, 1);
  assert.strictEqual(context.room.pendingRequest, context.nextStage);

  const committedHands = cloneHands(context.room);
  context.sockets[0].send("returnCardToAsshole", returnPayload);
  assertHandsEqual(context.room, committedHands);
  assert.strictEqual(context.firstStage.requestsMade, 1);
}

// 2/4. A requester disconnect keeps the untouched transaction reserved and a
// recovery inside the grace window restores the return prompt and can commit.
{
  const context = setupTransaction();
  const beforeHands = cloneHands(context.room);
  acceptRequestedKing(context);
  context.sockets[0].disconnect();
  assertHandsEqual(context.room, beforeHands);
  assert.strictEqual(context.firstStage.awaitingReturn, true);

  const recoveredRequester = makeSocket("requester-recovered");
  recover(context, recoveredRequester, context.tokens[0]);
  assert.strictEqual(context.firstStage.requesterId, recoveredRequester.id);
  assert(recoveredRequester.last("chooseCardToReturn"));
  recoveredRequester.send(
    "returnCardToAsshole",
    context.makePayload({
      roomCode: context.roomCode,
      card: card("3", SPADES),
    }),
  );
  assert.strictEqual(context.firstStage.requestsMade, 1);
  assert.deepStrictEqual(
    roomCardIdentities(context.room),
    beforeHands.flat().map(identity).sort(),
  );
}

// 3/4. A responder disconnect prevents commit while offline. Recovery keeps
// the exact pending card reservation and allows the original transaction.
{
  const context = setupTransaction();
  const beforeHands = cloneHands(context.room);
  acceptRequestedKing(context);
  context.sockets[1].disconnect();

  const promptsBeforeOfflineReturn = context.broadcasts.filter(
    (entry) =>
      entry.target === context.sockets[0].id &&
      entry.event === "chooseCardToReturn",
  ).length;
  context.sockets[0].send(
    "returnCardToAsshole",
    context.makePayload({
      roomCode: context.roomCode,
      card: card("3", SPADES),
    }),
  );
  assertHandsEqual(context.room, beforeHands);
  assert.strictEqual(context.firstStage.awaitingReturn, true);
  assert.strictEqual(
    context.broadcasts.filter(
      (entry) =>
        entry.target === context.sockets[0].id &&
        entry.event === "chooseCardToReturn",
    ).length,
    promptsBeforeOfflineReturn + 1,
  );

  const recoveredResponder = makeSocket("responder-recovered");
  recover(context, recoveredResponder, context.tokens[1]);
  assert.strictEqual(context.firstStage.responderId, recoveredResponder.id);
  assert.strictEqual(
    identity(context.firstStage.pendingTransferCard),
    `K:${HEARTS}`,
  );

  context.sockets[0].send(
    "returnCardToAsshole",
    context.makePayload({
      roomCode: context.roomCode,
      card: card("3", SPADES),
    }),
  );
  assert.strictEqual(context.firstStage.requestsMade, 1);
}

// 5/8/9. Grace expiry cancels an uncommitted stage without moving either
// requested/return card, then starts the unrelated next queue stage.
{
  const context = setupTransaction();
  const beforeHands = cloneHands(context.room);
  acceptRequestedKing(context);
  context.sockets[0].disconnect();
  const timerId = context.disconnectTimers.get(context.tokens[0]);
  context.runTimer(timerId);

  const liveRoom = context.rooms[context.roomCode];
  assert.strictEqual(liveRoom.pendingRequest, context.nextStage);
  assert.strictEqual(liveRoom.exchangeQueue.length, 1);
  assert.deepStrictEqual(liveRoom[0].hand, beforeHands[1]);
  assert(
    liveRoom[0].hand.some(
      (value) => identity(value) === `K:${HEARTS}`,
    ),
  );
  assert.strictEqual(
    liveRoom.reduce((total, player) => total + player.hand.length, 0),
    6,
  );
}

// An explicit responder Leave uses the same cancellation path immediately:
// the requester never receives the reserved card and the next stage proceeds.
{
  const context = setupTransaction();
  const requesterHand = cloneHands(context.room)[0];
  acceptRequestedKing(context);
  context.sockets[1].send("leaveRoom", context.roomCode);

  const liveRoom = context.rooms[context.roomCode];
  assert.strictEqual(liveRoom.pendingRequest, context.nextStage);
  assert.deepStrictEqual(liveRoom[0].hand, requesterHand);
  assert.strictEqual(
    liveRoom[0].hand.some((value) => identity(value) === `K:${HEARTS}`),
    false,
  );
}

console.log("human exchange transaction integration tests passed");
