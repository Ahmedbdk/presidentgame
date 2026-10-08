const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadServerHarness() {
  const serverPath = path.join(__dirname, "server.js");
  const source = `${fs.readFileSync(serverPath, "utf8")}
module.exports = {
  ROOM_PHASES,
  RECONNECT_GRACE_MS,
  rooms,
  socketRoomCodes,
  playerSessions,
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
    clear() {
      emitted.length = 0;
    },
  };
}

const harness = loadServerHarness();
const {
  ROOM_PHASES,
  RECONNECT_GRACE_MS,
  rooms,
  socketRoomCodes,
  playerSessions,
  disconnectTimers,
  broadcasts,
  timers,
  connect,
  makePayload,
  runTimer,
} = harness;

function recover(socket, roomCode, sessionToken) {
  let acknowledgement;
  socket.send(
    "recoverSession",
    makePayload({ roomCode, sessionToken }),
    (result) => {
      acknowledgement = result;
    },
  );
  return acknowledgement;
}

function assertSingleSeat(room, token, expectedId) {
  const matching = room.filter((player) => player.sessionToken === token);
  assert.strictEqual(matching.length, 1, "session must own exactly one seat");
  assert.strictEqual(matching[0].id, expectedId);
  assert.strictEqual(new Set(room.map((player) => player.id)).size, room.length);
}

function roomTurnBroadcastsSince(startIndex) {
  return broadcasts
    .slice(startIndex)
    .filter(
      (entry) => entry.target === roomCode && entry.event === "turnUpdate",
    );
}

const host = makeSocket("host-1");
const guest = makeSocket("guest-1");
connect(host);
connect(guest);

host.send("createRoom", makePayload({ username: "Host", avatar: null }));
const roomCreated = host.last("roomCreated").payload;
const roomCode = roomCreated.roomCode;
const hostToken = host.last("sessionAssigned").payload.sessionToken;

guest.send(
  "joinRoom",
  makePayload({ roomCode, username: "Guest", avatar: null }),
);
const guestToken = guest.last("sessionAssigned").payload.sessionToken;
const room = rooms[roomCode];
const originalHostHand = [{ rank: "A", suit: "â™ " }];
room[0].hand = originalHostHand;
room[1].hand = [{ rank: "2", suit: "â™¥" }];

assert.strictEqual(RECONNECT_GRACE_MS, 30_000);
assert.match(hostToken, /^[A-Za-z0-9_-]{43}$/);
assert.notStrictEqual(hostToken, guestToken);

// 1. Refresh in WAITING restores the exact host seat and private hand.
host.disconnect();
const hostTimer = disconnectTimers.get(hostToken);
assert.strictEqual(timers.get(hostTimer).delay, RECONNECT_GRACE_MS);
const refreshedHost = makeSocket("host-2");
connect(refreshedHost);
const waitingRecoveryBroadcastStart = broadcasts.length;
assert.strictEqual(recover(refreshedHost, roomCode, hostToken).ok, true);
assertSingleSeat(room, hostToken, refreshedHost.id);
assert.strictEqual(room[0].host, true);
assert.strictEqual(room[0].username, "Host");
assert.strictEqual(room[0].connected, true);
assert.strictEqual(disconnectTimers.has(hostToken), false);
assert.deepStrictEqual(refreshedHost.last("yourCards").payload, originalHostHand);
assert.deepStrictEqual(
  roomTurnBroadcastsSince(waitingRecoveryBroadcastStart),
  [],
  "WAITING recovery must not broadcast gameplay turn state",
);

// 2/3/10. Refresh during the turn and while waiting preserves turn ownership,
// table state, host status, and produces no duplicate seat.
room.phase = ROOM_PHASES.PLAYING;
room.currentTurnId = refreshedHost.id;
room.lastPlayedId = refreshedHost.id;
room.table = [{ rank: "K", suit: "â™¦" }];
room.passedPlayerIds = new Set([refreshedHost.id]);
room.roundParticipantIds = Object.freeze([refreshedHost.id, guest.id]);
refreshedHost.disconnect();
const turnHost = makeSocket("host-3");
connect(turnHost);
const currentTurnRecoveryBroadcastStart = broadcasts.length;
recover(turnHost, roomCode, hostToken);
assert.strictEqual(room.currentTurnId, turnHost.id);
assert.strictEqual(room.lastPlayedId, turnHost.id);
assert(room.passedPlayerIds.has(turnHost.id));
assert.deepStrictEqual(Array.from(room.roundParticipantIds), [turnHost.id, guest.id]);
assert.deepStrictEqual(turnHost.last("tableUpdate").payload.table, room.table);
assert.strictEqual(turnHost.last("turnUpdate").payload.playerId, turnHost.id);
assert.strictEqual(room[0].host, true);
assert.deepStrictEqual(
  roomTurnBroadcastsSince(currentTurnRecoveryBroadcastStart).map(
    (entry) => entry.payload.playerId,
  ),
  [turnHost.id],
  "the whole room must immediately receive the rebound current-turn ID",
);

room.currentTurnId = guest.id;
turnHost.disconnect();
const waitingHost = makeSocket("host-4");
connect(waitingHost);
const nonCurrentRecoveryBroadcastStart = broadcasts.length;
recover(waitingHost, roomCode, hostToken);
assert.strictEqual(room.currentTurnId, guest.id);
assert.strictEqual(waitingHost.last("turnUpdate").payload.playerId, guest.id);
assert.deepStrictEqual(
  roomTurnBroadcastsSince(nonCurrentRecoveryBroadcastStart).map(
    (entry) => entry.payload.playerId,
  ),
  [guest.id],
  "a non-current recovery must re-project, but never change, the turn",
);

// 4. A reconnecting spectator remains the same spectator, never a player.
room[1].spectator = true;
room.currentTurnId = waitingHost.id;
guest.disconnect();
const spectator = makeSocket("guest-2");
connect(spectator);
const spectatorRecoveryBroadcastStart = broadcasts.length;
recover(spectator, roomCode, guestToken);
assertSingleSeat(room, guestToken, spectator.id);
assert.strictEqual(room[1].spectator, true);
assert.strictEqual(room.currentTurnId, waitingHost.id);
assert.deepStrictEqual(
  roomTurnBroadcastsSince(spectatorRecoveryBroadcastStart).map(
    (entry) => entry.payload.playerId,
  ),
  [waitingHost.id],
  "PLAYING spectator recovery must synchronize without changing the turn",
);

// 5. RESULTS restores standings and that session's Ready vote.
room.phase = ROOM_PHASES.RESULTS;
room[1].spectator = false;
room.finishedPlayers = room.map((player, index) => ({
  ...player,
  hand: [],
  finished: true,
  rank: index === 0 ? "President" : "Asshole",
  finishPosition: index + 1,
}));
room.readyPlayers = new Set([waitingHost.id]);
waitingHost.disconnect();
const resultsHost = makeSocket("host-5");
connect(resultsHost);
const resultsRecoveryBroadcastStart = broadcasts.length;
recover(resultsHost, roomCode, hostToken);
assert(room.readyPlayers.has(resultsHost.id));
assert.strictEqual(resultsHost.last("sessionRecovered").payload.ready, true);
assert.strictEqual(resultsHost.last("gameFinished").payload.rankings.length, 2);
assert.deepStrictEqual(
  roomTurnBroadcastsSince(resultsRecoveryBroadcastStart),
  [],
  "RESULTS recovery must not broadcast gameplay turn state",
);

// 6/7. EXCHANGE restores both requester and responder private stages, while
// rebinding every exchange reference to the replacement transport.
room.phase = ROOM_PHASES.EXCHANGE;
room.exchangeQueue = [
  {
    requesterId: resultsHost.id,
    requesterUsername: "Host",
    responderId: spectator.id,
    responderUsername: "Guest",
    totalRequests: 2,
    requestsMade: 0,
    pendingRank: null,
    awaitingReturn: false,
  },
];
room.pendingRequest = room.exchangeQueue[0];
resultsHost.disconnect();
const exchangePresident = makeSocket("host-6");
connect(exchangePresident);
const exchangeRecoveryBroadcastStart = broadcasts.length;
recover(exchangePresident, roomCode, hostToken);
assert.strictEqual(room.pendingRequest.requesterId, exchangePresident.id);
assert(exchangePresident.last("chooseCardRequest"));
assert.deepStrictEqual(
  roomTurnBroadcastsSince(exchangeRecoveryBroadcastStart),
  [],
  "EXCHANGE recovery must not broadcast gameplay turn state",
);

room.pendingRequest.pendingRank = "2";
spectator.disconnect();
const exchangeAsshole = makeSocket("guest-3");
connect(exchangeAsshole);
recover(exchangeAsshole, roomCode, guestToken);
assert.strictEqual(room.pendingRequest.responderId, exchangeAsshole.id);
assert.strictEqual(exchangeAsshole.last("cardRequested").payload.rank, "2");

// The Vice President/Vice Asshole stage uses the same recovery contract but
// a one-card quantity; verify both endpoints rather than assuming the P/A
// stage is representative.
room.finishedPlayers[0].rank = "Vice President";
room.finishedPlayers[1].rank = "Vice Asshole";
room.exchangeQueue = [
  {
    requesterId: exchangePresident.id,
    requesterUsername: "Host",
    responderId: exchangeAsshole.id,
    responderUsername: "Guest",
    totalRequests: 1,
    requestsMade: 0,
    pendingRank: null,
    awaitingReturn: false,
  },
];
room.pendingRequest = room.exchangeQueue[0];
exchangePresident.disconnect();
const exchangeVicePresident = makeSocket("host-vp");
connect(exchangeVicePresident);
recover(exchangeVicePresident, roomCode, hostToken);
assert.strictEqual(room.pendingRequest.requesterId, exchangeVicePresident.id);
assert.strictEqual(
  exchangeVicePresident.last("chooseCardRequest").payload.totalRequests,
  1,
);

room.pendingRequest.pendingRank = "2";
exchangeAsshole.disconnect();
const exchangeViceAsshole = makeSocket("guest-va");
connect(exchangeViceAsshole);
recover(exchangeViceAsshole, roomCode, guestToken);
assert.strictEqual(room.pendingRequest.responderId, exchangeViceAsshole.id);
assert(exchangeViceAsshole.last("cardRequested"));

// 8. A temporary disconnect cancels its grace removal when recovery wins.
exchangeVicePresident.disconnect();
const temporaryTimer = disconnectTimers.get(hostToken);
const temporaryRecovery = makeSocket("host-7");
connect(temporaryRecovery);
recover(temporaryRecovery, roomCode, hostToken);
assert.strictEqual(timers.has(temporaryTimer), false);
assertSingleSeat(room, hostToken, temporaryRecovery.id);

// 11/13. A second live tab atomically replaces the first and cannot append.
const secondTab = makeSocket("host-8");
connect(secondTab);
recover(secondTab, roomCode, hostToken);
assertSingleSeat(room, hostToken, secondTab.id);
assert(temporaryRecovery.last("sessionReplaced"));
assert.strictEqual(socketRoomCodes.has(temporaryRecovery.id), false);

// 12. A forged token cannot claim, mutate, or learn a seat.
const attacker = makeSocket("attacker");
connect(attacker);
const beforeIds = room.map((player) => player.id);
assert.strictEqual(recover(attacker, roomCode, "A".repeat(43)).ok, false);
assert.deepStrictEqual(room.map((player) => player.id), beforeIds);
assert.strictEqual(socketRoomCodes.has(attacker.id), false);
assert.strictEqual(attacker.last("yourCards"), undefined);

// 14. Recovery sends exactly the owner's private hand; public snapshots never
// contain another player's hand.
secondTab.clear();
secondTab.disconnect();
const privateRecovery = makeSocket("host-9");
connect(privateRecovery);
recover(privateRecovery, roomCode, hostToken);
const handEvents = privateRecovery.emitted.filter(
  (entry) => entry.event === "yourCards",
);
assert.strictEqual(handEvents.length, 1);
assert.deepStrictEqual(handEvents[0].payload, room[0].hand);
const latestRoomBroadcast = [...broadcasts]
  .reverse()
  .find((entry) => entry.event === "updateRoom" && entry.target === roomCode);
assert(latestRoomBroadcast.payload.players.every((player) => !("hand" in player)));

// 9. Expiry permanently removes through the existing lifecycle path and
// invalidates the token, after which recovery fails.
room.phase = ROOM_PHASES.WAITING;
room[1].spectator = false;
exchangeViceAsshole.disconnect();
const expiryTimer = disconnectTimers.get(guestToken);
runTimer(expiryTimer);
assert.strictEqual(
  rooms[roomCode].some((player) => player.sessionToken === guestToken),
  false,
);
assert.strictEqual(playerSessions.has(guestToken), false);
const tooLate = makeSocket("guest-too-late");
connect(tooLate);
assert.strictEqual(recover(tooLate, roomCode, guestToken).ok, false);

console.log("session recovery integration tests passed");
