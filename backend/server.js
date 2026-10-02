const express = require("express");
const http = require("http");
const cors = require("cors");
const crypto = require("crypto");
const { URL } = require("url");
const { Server } = require("socket.io");

const DEVELOPMENT_FRONTEND_ORIGIN = "http://localhost:5173";
const DEFAULT_SERVER_PORT = 3001;

function resolveServerPort(configuredPort) {
  if (configuredPort === undefined) return DEFAULT_SERVER_PORT;

  if (
    typeof configuredPort !== "string" ||
    !/^\d+$/.test(configuredPort.trim())
  ) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const port = Number(configuredPort.trim());

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return port;
}

const SERVER_PORT = resolveServerPort(globalThis.process?.env?.PORT);

function normalizeAllowedOrigin(value) {
  if (typeof value !== "string" || value.trim() === "") return null;

  try {
    const parsed = new URL(value.trim());

    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }

    return parsed.origin;
  } catch {
    return null;
  }
}

function parseAllowedCorsOrigins(configuredOrigins) {
  const source =
    typeof configuredOrigins === "string" && configuredOrigins.trim()
      ? configuredOrigins
      : DEVELOPMENT_FRONTEND_ORIGIN;
  const rawOrigins = source.split(",").map((origin) => origin.trim());
  const normalizedOrigins = rawOrigins.map(normalizeAllowedOrigin);

  if (
    rawOrigins.some((origin) => !origin) ||
    normalizedOrigins.some((origin) => !origin)
  ) {
    throw new Error(
      "CORS_ALLOWED_ORIGINS must contain only comma-separated http(s) origins without paths",
    );
  }

  return Object.freeze([...new Set(normalizedOrigins)]);
}

const allowedCorsOrigins = parseAllowedCorsOrigins(
  globalThis.process?.env?.CORS_ALLOWED_ORIGINS,
);

function isAllowedRequestOrigin(origin) {
  return !origin || allowedCorsOrigins.includes(origin);
}

const corsOptions = {
  origin(origin, callback) {
    // Requests without an Origin header are not browser cross-origin calls.
    // Browser origins must match the configured allowlist exactly.
    if (isAllowedRequestOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error("Origin is not allowed by CORS"));
  },
};

const app = express();

app.use(cors(corsOptions));

const server = http.createServer(app);

const io = new Server(server, {
  cors: corsOptions,
  // WebSocket upgrades are not governed by browser CORS enforcement. Apply
  // the same allowlist at Socket.IO's transport handshake as well.
  allowRequest(request, callback) {
    callback(null, isAllowedRequestOrigin(request.headers.origin));
  },
});

// Store rooms without an Object prototype so user-controlled keys such
// as "constructor", "toString", or "__proto__" can never resolve to
// inherited state. Bracket lookup/delete semantics remain unchanged.
const rooms = Object.create(null);

// A connected socket may own exactly one seat in exactly one game room.
// Keeping that relationship separate from Socket.IO's adapter rooms makes
// duplicate/replayed Create and Join events safe to resolve idempotently.
const socketRoomCodes = new Map();

// Socket IDs are transport identities and change after a refresh/reconnect.
// A strong, opaque session token owns the durable player seat instead. A
// disconnected seat remains reserved briefly so a replacement socket can
// atomically rebind to it without changing any authoritative game state.
const playerSessions = new Map();
const disconnectTimers = new Map();
const RECONNECT_GRACE_MS = 30_000;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const ROOM_CODE_PATTERN = /^[A-Z0-9]{4}$/;
const USERNAME_MAX_LENGTH = 32;
const MAX_ROOM_CAPACITY = 8;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;
const configuredExchangeTimeout = Number(
  globalThis.process?.env?.EXCHANGE_ACTION_TIMEOUT_MS,
);
const EXCHANGE_ACTION_TIMEOUT_MS =
  Number.isFinite(configuredExchangeTimeout) && configuredExchangeTimeout >= 1_000
    ? configuredExchangeTimeout
    : 45_000;
const ENABLE_DEBUG_TOOLS =
  globalThis.process?.env?.ENABLE_DEBUG_TOOLS === "true";

const ROOM_PHASES = Object.freeze({
  WAITING: "WAITING",
  PLAYING: "PLAYING",
  RESULTS: "RESULTS",
  EXCHANGE: "EXCHANGE",
});

function generateRoomCode() {
  return Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0")
    .toUpperCase();
}

const suits = ["♠", "♥", "♦", "♣"];

const ranks = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A",
];

const DECK_CARD_COUNT = suits.length * ranks.length;
const ROOM_FULL_ERROR = `Room is full (maximum ${MAX_ROOM_CAPACITY} players).`;

function canDealEveryRoomMember(room) {
  return (
    Array.isArray(room) &&
    room.length > 0 &&
    room.length <= MAX_ROOM_CAPACITY &&
    Math.floor(DECK_CARD_COUNT / room.length) >= 1
  );
}

const REQUESTABLE_RANKS = new Set([...ranks, "JOKER"]);
const PHYSICAL_RANKS = new Set(ranks);
const PHYSICAL_SUITS = new Set(suits);

const VALID_AVATARS = new Set([
  "🦁",
  "🐯",
  "🐻",
  "🦊",
  "🐼",
  "🐨",
  "🐵",
  "🐸",
  "🐺",
  "🦉",
  "🐙",
  "🦄",
  "🐧",
  "🦋",
  "🐬",
  "🦖",
]);

const DEBUG_RANKS = [
  "President",
  "Vice President",
  "Vice Asshole",
  "Asshole",
];

function isPlainPayload(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function hasPayloadShape(payload, requiredKeys, optionalKeys = []) {
  if (!isPlainPayload(payload)) return false;

  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  const actualKeys = Reflect.ownKeys(payload);

  return (
    requiredKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(payload, key),
    ) &&
    actualKeys.every(
      (key) => typeof key === "string" && allowedKeys.has(key),
    )
  );
}

function isValidRoomCode(roomCode) {
  return typeof roomCode === "string" && ROOM_CODE_PATTERN.test(roomCode);
}

function isValidSessionToken(sessionToken) {
  return (
    typeof sessionToken === "string" &&
    SESSION_TOKEN_PATTERN.test(sessionToken)
  );
}

function normalizeJoinRoomCode(roomCode) {
  if (typeof roomCode !== "string") return null;

  const normalized = roomCode.trim().toUpperCase();

  return isValidRoomCode(normalized) ? normalized : null;
}

function isValidUsername(username) {
  return (
    typeof username === "string" &&
    username.length <= USERNAME_MAX_LENGTH * 2 &&
    username.trim().length > 0 &&
    [...username].length <= USERNAME_MAX_LENGTH &&
    !CONTROL_CHARACTER_PATTERN.test(username)
  );
}

function isValidAvatar(avatar) {
  return (
    avatar === undefined ||
    avatar === null ||
    avatar === "" ||
    (typeof avatar === "string" && VALID_AVATARS.has(avatar))
  );
}

function isValidPhysicalCard(card) {
  return (
    hasPayloadShape(card, ["rank", "suit"]) &&
    typeof card.rank === "string" &&
    typeof card.suit === "string" &&
    PHYSICAL_RANKS.has(card.rank) &&
    PHYSICAL_SUITS.has(card.suit)
  );
}

function isValidPlayedCards(cards) {
  return (
    Array.isArray(cards) &&
    cards.length >= 1 &&
    cards.length <= 4 &&
    cards.every(isValidPhysicalCard)
  );
}

function rejectInvalidPayload(socket, action) {
  socket.emit("errorMessage", `Invalid ${action} request`);
}

const cardValues = {
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

function createDeck() {
  let deck = [];

  for (let suit of suits) {
    for (let rank of ranks) {
      deck.push({
        rank,
        suit,
      });
    }
  }

  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));

    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function isValidSet(cards) {
  if (!Array.isArray(cards) || cards.length === 0) {
    return false;
  }

  if (cards.length > 4) {
    return false;
  }

  const rank = cards[0].rank;

  return cards.every((card) => card.rank === rank);
}

// A bomb is four of a kind - it beats any non-bomb play regardless of
// how many cards are on the table, and only a higher bomb beats it
function isBomb(cards) {
  return (
    Array.isArray(cards) &&
    cards.length === 4 &&
    new Set(cards.map((card) => card.rank)).size === 1
  );
}

function getPlayValue(cards) {
  let values = cards.map((card) => cardValues[card.rank]);

  if (isBomb(cards)) {
    // Offset bombs above every normal value (max is 14) so any bomb
    // beats any non-bomb, and rank breaks ties between two bombs
    return 100 + values[0];
  }

  return Math.max(...values);
}

function highestCards(hand, count) {
  return [...hand]
    .sort((a, b) => cardValues[b.rank] - cardValues[a.rank])
    .slice(0, count);
}

function lowestCards(hand, count) {
  return [...hand]
    .sort((a, b) => cardValues[a.rank] - cardValues[b.rank])
    .slice(0, count);
}

function removeCardsFromHand(hand, cardsToRemove) {
  cardsToRemove.forEach((card) => {
    const index = hand.findIndex(
      (c) => c.rank === card.rank && c.suit === card.suit,
    );

    if (index !== -1) {
      hand.splice(index, 1);
    }
  });
}

// Confirms every card being played is actually in the player's hand -
// checked as a multiset, so claiming the same real card twice (when
// you only hold one copy) is rejected just like claiming a card you
// never had at all
function handContainsCards(hand, cards) {
  const remaining = [...hand];

  for (const card of cards) {
    const index = remaining.findIndex(
      (c) => c.rank === card.rank && c.suit === card.suit,
    );

    if (index === -1) {
      return false;
    }

    remaining.splice(index, 1);
  }

  return true;
}

function dealHands(room) {
  const deck = shuffle(createDeck());

  const totalPlayers = room.length;

  const cardsPerPlayer = Math.floor(deck.length / totalPlayers);

  const leftover = deck.length % totalPlayers;

  room.forEach((player) => {
    player.hand = deck.splice(0, cardsPerPlayer);
  });

  // Every card gets dealt out - whatever doesn't divide evenly goes
  // one at a time to a random subset of players (e.g. 5 players: 10
  // each, then the last 2 cards go to two random players; 6 players:
  // 8 each, then the last 4 cards go to four random players)
  if (leftover > 0) {
    const luckyIndices = shuffle(room.map((_, index) => index)).slice(
      0,
      leftover,
    );

    luckyIndices.forEach((index) => {
      room[index].hand.push(deck.shift());
    });
  }
}

// Strips actual card data out of the room before broadcasting it to
// everyone - other players (and late joiners) should only ever see
// how many cards someone is holding, never what those cards are.
function sanitizeRoom(room) {
  return room.map((player) => ({
    id: player.id,
    username: player.username,
    avatar: player.avatar || null,
    host: player.host,
    finished: player.finished,
    rank: player.rank,
    finishPosition: player.finishPosition || null,
    cardCount: player.hand ? player.hand.length : 0,
    spectator: !!player.spectator,
    connected: player.connected !== false,
  }));
}

function broadcastRoom(roomCode, room) {
  io.to(roomCode).emit("updateRoom", {
    roomCode,
    phase: room.phase,
    players: sanitizeRoom(room),
  });
}

// Same idea as sanitizeRoom, but for the finishedPlayers list sent
// alongside "gameFinished" - strips hand data so a round-end broadcast
// never leaks anyone's actual cards to other clients.
function sanitizeFinishedPlayers(finishedPlayers) {
  return finishedPlayers.map((player) => ({
    id: player.id,
    username: player.username,
    avatar: player.avatar || null,
    host: player.host,
    rank: player.rank,
    finishPosition: player.finishPosition || null,
  }));
}

function getSocketRoomMembership(socketId) {
  const mappedRoomCode = socketRoomCodes.get(socketId);

  if (mappedRoomCode) {
    const mappedRoom = rooms[mappedRoomCode];
    const mappedPlayer = mappedRoom?.find((player) => player.id === socketId);

    if (mappedPlayer) {
      return {
        roomCode: mappedRoomCode,
        room: mappedRoom,
        player: mappedPlayer,
      };
    }

    // Self-heal a stale lookup before considering a new membership.
    socketRoomCodes.delete(socketId);
  }

  // Defensive recovery for any seat created before the lookup existed or
  // if the lookup was ever lost: the room record remains authoritative.
  for (const roomCode in rooms) {
    const room = rooms[roomCode];
    const player = room?.find((candidate) => candidate.id === socketId);

    if (player) {
      socketRoomCodes.set(socketId, roomCode);

      return { roomCode, room, player };
    }
  }

  return null;
}

function clearSocketRoomMembership(socketId, roomCode) {
  if (socketRoomCodes.get(socketId) === roomCode) {
    socketRoomCodes.delete(socketId);
  }
}

function createPlayerSession(roomCode, player) {
  let sessionToken;

  do {
    sessionToken = crypto.randomBytes(32).toString("base64url");
  } while (playerSessions.has(sessionToken));

  player.sessionToken = sessionToken;
  player.connected = true;
  playerSessions.set(sessionToken, { roomCode, playerId: player.id });

  return sessionToken;
}

function clearDisconnectTimer(sessionToken) {
  const timer = disconnectTimers.get(sessionToken);

  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(sessionToken);
  }
}

function clearPlayerSession(player, roomCode) {
  if (!player?.sessionToken) return;

  clearDisconnectTimer(player.sessionToken);

  const session = playerSessions.get(player.sessionToken);
  if (!session || session.roomCode === roomCode) {
    playerSessions.delete(player.sessionToken);
  }
}

function replaceIdInSet(value, oldId, newId) {
  if (!(value instanceof Set) || !value.has(oldId)) return value;

  const replaced = new Set(value);
  replaced.delete(oldId);
  replaced.add(newId);
  return replaced;
}

function rebindPlayerSocketId(room, player, oldId, newId) {
  player.id = newId;
  player.connected = true;

  if (room.currentTurnId === oldId) room.currentTurnId = newId;
  if (room.lastPlayedId === oldId) room.lastPlayedId = newId;
  if (room.previousAsshole === oldId) room.previousAsshole = newId;

  room.readyPlayers = replaceIdInSet(room.readyPlayers, oldId, newId);
  room.passedPlayerIds = replaceIdInSet(
    room.passedPlayerIds,
    oldId,
    newId,
  );

  if (Array.isArray(room.roundParticipantIds)) {
    room.roundParticipantIds = Object.freeze(
      room.roundParticipantIds.map((id) => (id === oldId ? newId : id)),
    );
  }

  const replaceRecordId = (record) => {
    if (record?.id === oldId) record.id = newId;
  };

  (room.finishedPlayers || []).forEach(replaceRecordId);
  (room.roundWithdrawals || []).forEach(replaceRecordId);

  const replaceExchangeIds = (exchange) => {
    if (!exchange) return;
    if (exchange.requesterId === oldId) exchange.requesterId = newId;
    if (exchange.responderId === oldId) exchange.responderId = newId;
  };

  (room.exchangeQueue || []).forEach(replaceExchangeIds);
  replaceExchangeIds(room.pendingRequest);
}

function emitSessionCredentials(socket, roomCode, player) {
  socket.emit("sessionAssigned", {
    roomCode,
    sessionToken: player.sessionToken,
  });
}

// Replayed same-room Create/Join requests do not add or rewrite a seat.
// Send only the state needed to bring that existing socket back in sync;
// all private card data remains scoped to its own player record.
function syncExistingRoomMembership(socket, membership) {
  const { roomCode, room, player } = membership;

  socket.join(roomCode);
  emitSessionCredentials(socket, roomCode, player);

  socket.emit("updateRoom", {
    roomCode,
    phase: room.phase,
    players: sanitizeRoom(room),
  });
  socket.emit("yourCards", player.hand || []);

  if (room.phase === ROOM_PHASES.PLAYING) {
    socket.emit("gameStarted");
    socket.emit("tableUpdate", {
      table: room.table || [],
      nextPlayer: room.currentTurnId || null,
    });
    socket.emit("turnUpdate", { playerId: room.currentTurnId || null });
    return;
  }

  if (room.phase === ROOM_PHASES.RESULTS) {
    socket.emit("gameFinished", {
      rankings: sanitizeFinishedPlayers(room.finishedPlayers || []),
    });

    const readyPlayers = getReadyPlayers(room);
    socket.emit("readyUpdate", {
      count: readyPlayers.size,
      total: getRoomMemberIds(room).size,
    });
    return;
  }

  if (room.phase !== ROOM_PHASES.EXCHANGE) return;

  // gameStarted/tableUpdate rebuild the table projection; the events below
  // immediately restore the Results-backed exchange view and any private
  // request/response prompt that belongs to this socket.
  socket.emit("gameStarted");
  socket.emit("tableUpdate", {
    table: room.table || [],
    nextPlayer: room.currentTurnId || null,
  });
  socket.emit("gameFinished", {
    rankings: sanitizeFinishedPlayers(room.finishedPlayers || []),
  });

  const exchange = room.pendingRequest;
  if (!exchange) return;

  socket.emit("exchangeInProgress", {
    requesterUsername: exchange.requesterUsername,
    responderUsername: exchange.responderUsername,
  });

  if (socket.id === exchange.requesterId) {
    if (exchange.awaitingReturn) {
      socket.emit("chooseCardToReturn", {
        responderUsername: exchange.responderUsername,
      });
    } else if (
      !exchange.pendingRank &&
      exchange.requestsMade < exchange.totalRequests
    ) {
      socket.emit("chooseCardRequest", {
        requestNumber: exchange.requestsMade + 1,
        totalRequests: exchange.totalRequests,
      });
    }
  }

  if (socket.id === exchange.responderId && exchange.pendingRank) {
    const responderHasCard = player.hand.some(
      (card) => card.rank === exchange.pendingRank,
    );

    socket.emit("cardRequested", {
      rank: exchange.pendingRank,
      requesterUsername: exchange.requesterUsername,
      responderHasCard,
    });
  }
}

// The guaranteed, automatic part of the exchange - no asking involved.
// 4 players or fewer: Asshole gives their highest card to President, no give-back.
// More than 4: Asshole <-> President swap 2 cards each way, Vice Asshole <-> Vice President swap 1 each way.
function autoExchange(room, roles) {
  const { president, asshole, vicePresident, viceAsshole } = roles;

  const totalPlayers = room.length;

  // Select every outgoing card from the hands as they existed before any
  // automatic transfer. This prevents an incoming card from immediately
  // being selected as that player's outgoing card in the same exchange.
  const handSnapshots = {
    president: president ? [...president.hand] : [],
    asshole: asshole ? [...asshole.hand] : [],
    vicePresident: vicePresident ? [...vicePresident.hand] : [],
    viceAsshole: viceAsshole ? [...viceAsshole.hand] : [],
  };
  const transferPlan = [];

  if (president && asshole) {
    const countPA = totalPlayers > 4 ? 2 : 1;

    transferPlan.push({
      from: asshole,
      to: president,
      cards: highestCards(handSnapshots.asshole, countPA),
    });

    if (totalPlayers > 4) {
      transferPlan.push({
        from: president,
        to: asshole,
        cards: lowestCards(handSnapshots.president, countPA),
      });
    }
  }

  if (totalPlayers > 4 && vicePresident && viceAsshole) {
    transferPlan.push(
      {
        from: viceAsshole,
        to: vicePresident,
        cards: highestCards(handSnapshots.viceAsshole, 1),
      },
      {
        from: vicePresident,
        to: viceAsshole,
        cards: lowestCards(handSnapshots.vicePresident, 1),
      },
    );
  }

  // Validate the complete plan before mutating a hand, then apply it. Under
  // normal authoritative standings this always succeeds; the preflight keeps
  // an invalid internal plan from producing a partial exchange or duplicates.
  const outgoingByPlayer = new Map();

  transferPlan.forEach(({ from, cards }) => {
    const outgoing = outgoingByPlayer.get(from) || [];

    outgoing.push(...cards);
    outgoingByPlayer.set(from, outgoing);
  });

  for (const [player, outgoing] of outgoingByPlayer) {
    if (!handContainsCards(player.hand, outgoing)) {
      console.error("Automatic exchange plan contains unavailable cards.");

      return false;
    }
  }

  transferPlan.forEach(({ from, to, cards }) => {
    removeCardsFromHand(from.hand, cards);
    to.hand.push(...cards);
  });

  return true;
}

// Capture exactly the players who receive cards in this deal. The frozen ID
// list and its count remain authoritative for ranking until this round ends;
// later joins, leaves, disconnects, and spectator changes must not alter it.
function snapshotRoundPopulation(room) {
  const participantIds = room.map((player) => player.id);

  room.roundParticipantIds = Object.freeze([...participantIds]);
  room.roundParticipantCount = participantIds.length;
  room.roundWithdrawals = [];
}

function isCurrentRoundParticipant(room, playerId) {
  return (
    Array.isArray(room.roundParticipantIds) &&
    room.roundParticipantIds.includes(playerId)
  );
}

// A dealt player who leaves before earning a finish position still belongs to
// this round's immutable population. Keep a detached, card-free record so it
// can receive one of the remaining positions when the round concludes.
function trackRoundWithdrawal(room, player) {
  if (
    (room.phase !== ROOM_PHASES.PLAYING &&
      room.phase !== ROOM_PHASES.EXCHANGE) ||
    !isCurrentRoundParticipant(room, player.id)
  ) {
    return;
  }

  if (!Array.isArray(room.roundWithdrawals)) {
    room.roundWithdrawals = [];
  }

  const alreadyWithdrawn = room.roundWithdrawals.some(
    (withdrawal) => withdrawal.id === player.id,
  );

  // During EXCHANGE, player.finished still reflects the previous round, so
  // only the new-round withdrawal ledger is relevant. During PLAYING, the
  // current finishedPlayers ledger tells us whether this player already owns
  // a real finish position that must simply remain preserved after departure.
  const alreadyFinishedThisRound =
    room.phase === ROOM_PHASES.PLAYING &&
    Array.isArray(room.finishedPlayers) &&
    room.finishedPlayers.some((finisher) => finisher.id === player.id);

  if (alreadyWithdrawn || alreadyFinishedThisRound) return;

  room.roundWithdrawals.push({
    id: player.id,
    username: player.username,
    avatar: player.avatar || null,
    host: false,
    hand: [],
    finished: false,
    rank: null,
    finishPosition: null,
    spectator: false,
    withdrew: true,
  });
}

function assignRank(room, player, forcedRank = null) {
  let finished = room.finishedPlayers;

  if (!finished.includes(player)) {
    finished.push(player);
  }

  player.finished = true;
  const totalPlayers = room.roundParticipantCount;

  if (forcedRank) {
    player.rank = forcedRank;
    // Ace Trap Assholes are ranked last immediately even if they empty
    // their hand earlier; this keeps President at 1st and Asshole at
    // the final position according to the existing role rules.
    player.finishPosition =
      forcedRank === "Asshole" ? totalPlayers : finished.indexOf(player) + 1;
    return;
  }

  // Count players who finished naturally (ignoring any forced Assholes)
  let normalFinishedCount = finished.filter((p) => p.rank !== "Asshole").length;

  player.finishPosition = normalFinishedCount;

  if (normalFinishedCount === 1) {
    player.rank = "President";
  } else if (normalFinishedCount === 2 && totalPlayers > 4) {
    player.rank = "Vice President";
  } else if (normalFinishedCount === totalPlayers - 1 && totalPlayers > 4) {
    player.rank = "Vice Asshole";
  } else if (normalFinishedCount === totalPlayers) {
    player.rank = "Asshole";
  } else {
    player.rank = null;
  }
}

// The completed-standings ledger is authoritative for the exclusive Asshole
// slot. Finished players remain in this ledger after leaving or disconnecting,
// so the first Ace punishment cannot be claimed again later in the round.
function hasRoundAsshole(room) {
  return (
    Array.isArray(room.finishedPlayers) &&
    room.finishedPlayers.some((player) => player.rank === "Asshole")
  );
}

function assignFinisherRank(room, player, finishedOnAces) {
  const claimsAssholeSlot = finishedOnAces && !hasRoundAsshole(room);

  assignRank(room, player, claimsAssholeSlot ? "Asshole" : null);
}

// Withdrawals are deliberately placed after every genuine finisher known at
// the terminal moment, but before the connected natural-last player. This
// preserves genuine finish order while ensuring every snapshotted participant
// occupies one unique position in the completed standings.
function rankPendingWithdrawals(room) {
  if (!Array.isArray(room.roundWithdrawals)) return;

  room.roundWithdrawals.forEach((withdrawal) => {
    const alreadyRanked = room.finishedPlayers.some(
      (finisher) => finisher.id === withdrawal.id,
    );

    if (!alreadyRanked) {
      assignRank(room, withdrawal);
    }
  });

  room.roundWithdrawals = [];
}

// Completing a play and removing an unfinished player can each reduce the
// round to one (or zero) connected unfinished participants. Keep the terminal
// ranking transition in one phase-guarded helper so either path closes the
// same immutable round exactly once.
function finishRoundIfReady(roomCode, room) {
  if (!room || room.phase !== ROOM_PHASES.PLAYING) return false;

  const remainingPlayers = room.filter(
    (player) => !player.finished && !player.spectator,
  );

  if (remainingPlayers.length > 1) return false;

  rankPendingWithdrawals(room);

  if (remainingPlayers.length === 1) {
    const lastPlayer = remainingPlayers[0];

    assignRank(room, lastPlayer, hasRoundAsshole(room) ? null : "Asshole");
    broadcastPlayerFinished(roomCode, lastPlayer);
  }

  clearExchangeActionTimeout(room);
  room.phase = ROOM_PHASES.RESULTS;
  room.readyPlayers = new Set();

  broadcastRoom(roomCode, room);

  io.to(roomCode).emit("gameFinished", {
    rankings: sanitizeFinishedPlayers(room.finishedPlayers),
  });

  return true;
}

function broadcastPlayerFinished(roomCode, player) {
  io.to(roomCode).emit("playerFinished", {
    id: player.id,
    username: player.username,
    rank: player.rank,
    finishPosition: player.finishPosition,
  });
}
// Builds one stage of the card-request queue - either the President
// asking the Asshole, or the Vice President asking the Vice Asshole.
// Both stages follow the exact same rules.
function buildExchangeStage(requester, responder, totalRequests) {
  return {
    requesterId: requester.id,
    requesterUsername: requester.username,
    responderId: responder.id,
    responderUsername: responder.username,
    totalRequests,
    requestsMade: 0,
    pendingRank: null,
    awaitingReturn: false,
    pendingTransferCard: null,
  };
}

const EXCHANGE_ACTIONS = Object.freeze({
  RANK_REQUEST: "RANK_REQUEST",
  CARD_RESPONSE: "CARD_RESPONSE",
  RETURN_CARD: "RETURN_CARD",
});

function clearExchangeActionTimeout(room) {
  if (!room) return;

  if (room.exchangeActionTimer !== null && room.exchangeActionTimer !== undefined) {
    clearTimeout(room.exchangeActionTimer);
  }

  room.exchangeActionTimer = null;
  room.exchangeActionDeadline = null;
  room.exchangeActionPausedRemainingMs = null;
  room.exchangeActionType = null;
  room.exchangeActionToken = (room.exchangeActionToken || 0) + 1;
}

function exchangeParticipantsAreConnected(room, exchange) {
  const requester = room.find((player) => player.id === exchange.requesterId);
  const responder = room.find((player) => player.id === exchange.responderId);

  return (
    !!requester &&
    !!responder &&
    requester.connected !== false &&
    responder.connected !== false
  );
}

function exchangeActionStillPending(exchange, actionType) {
  if (actionType === EXCHANGE_ACTIONS.RANK_REQUEST) {
    return !exchange.pendingRank && !exchange.awaitingReturn;
  }

  if (actionType === EXCHANGE_ACTIONS.CARD_RESPONSE) {
    return !!exchange.pendingRank && !exchange.awaitingReturn;
  }

  if (actionType === EXCHANGE_ACTIONS.RETURN_CARD) {
    return (
      exchange.awaitingReturn &&
      isValidPhysicalCard(exchange.pendingTransferCard)
    );
  }

  return false;
}

function skipTimedOutExchangeRequest(roomCode, room, exchange) {
  exchange.pendingRank = null;
  exchange.awaitingReturn = false;
  exchange.pendingTransferCard = null;
  exchange.requestsMade += 1;

  // This existing UI event clears whichever rank/offer/return prompt timed
  // out. promptNextCardRequest then emits the next authoritative prompt.
  io.to(roomCode).emit("exchangeStageCancelled");
  promptNextCardRequest(roomCode);
}

function scheduleExchangeActionTimeout(
  roomCode,
  room,
  exchange,
  actionType,
  delay = EXCHANGE_ACTION_TIMEOUT_MS,
) {
  clearExchangeActionTimeout(room);

  if (
    room.phase !== ROOM_PHASES.EXCHANGE ||
    room.pendingRequest !== exchange ||
    !exchangeActionStillPending(exchange, actionType)
  ) {
    return;
  }

  const timeoutDelay = Math.max(1, delay);
  const token = room.exchangeActionToken;
  const requestNumber = exchange.requestsMade;

  room.exchangeActionType = actionType;

  // A participant inside the reconnect grace period keeps the same pending
  // action without consuming inactivity time. Recovery resumes this balance;
  // grace expiry cancels the stage through the normal removal path.
  if (!exchangeParticipantsAreConnected(room, exchange)) {
    room.exchangeActionPausedRemainingMs = timeoutDelay;
    return;
  }

  room.exchangeActionDeadline = Date.now() + timeoutDelay;
  room.exchangeActionTimer = setTimeout(() => {
    const currentRoom = rooms[roomCode];

    if (
      !currentRoom ||
      currentRoom.phase !== ROOM_PHASES.EXCHANGE ||
      currentRoom.pendingRequest !== exchange ||
      currentRoom.exchangeActionToken !== token ||
      exchange.requestsMade !== requestNumber ||
      !exchangeActionStillPending(exchange, actionType)
    ) {
      return;
    }

    currentRoom.exchangeActionTimer = null;
    currentRoom.exchangeActionDeadline = null;
    currentRoom.exchangeActionPausedRemainingMs = null;
    currentRoom.exchangeActionType = null;
    currentRoom.exchangeActionToken += 1;

    skipTimedOutExchangeRequest(roomCode, currentRoom, exchange);
  }, timeoutDelay);
}

function pauseExchangeActionTimeoutForPlayer(room, playerId) {
  const exchange = room?.pendingRequest;

  if (
    !exchange ||
    room.phase !== ROOM_PHASES.EXCHANGE ||
    (exchange.requesterId !== playerId && exchange.responderId !== playerId) ||
    room.exchangeActionTimer === null ||
    room.exchangeActionTimer === undefined
  ) {
    return;
  }

  const remaining = Math.max(
    1,
    (room.exchangeActionDeadline || Date.now()) - Date.now(),
  );

  clearTimeout(room.exchangeActionTimer);
  room.exchangeActionTimer = null;
  room.exchangeActionDeadline = null;
  room.exchangeActionPausedRemainingMs = remaining;
}

function resumeExchangeActionTimeout(roomCode, room) {
  if (
    !room ||
    room.phase !== ROOM_PHASES.EXCHANGE ||
    !room.pendingRequest ||
    !room.exchangeActionType ||
    room.exchangeActionPausedRemainingMs === null ||
    room.exchangeActionPausedRemainingMs === undefined ||
    !exchangeParticipantsAreConnected(room, room.pendingRequest)
  ) {
    return;
  }

  const actionType = room.exchangeActionType;
  const remaining = room.exchangeActionPausedRemainingMs;

  scheduleExchangeActionTimeout(
    roomCode,
    room,
    room.pendingRequest,
    actionType,
    remaining,
  );
}

function getRoomMemberIds(room) {
  return new Set(room.map((player) => player.id));
}

function getReadyPlayers(room) {
  if (!(room.readyPlayers instanceof Set)) {
    room.readyPlayers = new Set();
  }

  // Keep readiness tied to the authoritative room membership. This
  // also prevents any stale/non-member id from contributing to quorum.
  const memberIds = getRoomMemberIds(room);

  for (const readyPlayerId of room.readyPlayers) {
    if (!memberIds.has(readyPlayerId)) {
      room.readyPlayers.delete(readyPlayerId);
    }
  }

  return room.readyPlayers;
}

function allRoomMembersReady(room) {
  const readyPlayers = getReadyPlayers(room);
  const memberIds = getRoomMemberIds(room);

  return (
    memberIds.size >= 2 &&
    [...memberIds].every((playerId) => readyPlayers.has(playerId))
  );
}

// Resolve exchange roles only from the finalized standings ledger. A role is
// usable when it appears exactly once and its holder ID is not reused by any
// other exclusive role. Presence in the new-round room is resolved separately
// by ID so a retained standings record never has to share object identity with
// the live seat.
function resolvePreviousRoundExchangeRoles(
  roomCode,
  room,
  finalizedStandings,
  includeViceRoles,
) {
  const standings = Array.isArray(finalizedStandings)
    ? finalizedStandings
    : [];
  const roleNames = ["President", "Asshole"];

  if (!Array.isArray(finalizedStandings)) {
    console.warn(
      `[EXCHANGE] Room ${roomCode} has no valid finalized standings ledger; role exchanges will be skipped`,
    );
  }

  if (includeViceRoles) {
    roleNames.push("Vice President", "Vice Asshole");
  }

  const resolvedRoles = Object.create(null);

  roleNames.forEach((role) => {
    const matches = standings.filter(
      (player) => player && typeof player === "object" && player.rank === role,
    );
    const standing = matches.length === 1 ? matches[0] : null;
    const validStanding = !!standing && typeof standing.id === "string";

    if (!validStanding) {
      console.warn(
        `[EXCHANGE] Room ${roomCode} has ${matches.length} finalized ${role} standings; skipping exchanges that require this role`,
      );
    }

    resolvedRoles[role] = {
      validStanding,
      standing,
      player: null,
    };
  });

  const rolesByHolderId = new Map();

  roleNames.forEach((role) => {
    const resolved = resolvedRoles[role];

    if (!resolved.validStanding) return;

    const existingRoles = rolesByHolderId.get(resolved.standing.id) || [];

    existingRoles.push(role);
    rolesByHolderId.set(resolved.standing.id, existingRoles);
  });

  rolesByHolderId.forEach((rolesForHolder, holderId) => {
    if (rolesForHolder.length === 1) return;

    console.warn(
      `[EXCHANGE] Room ${roomCode} assigns exclusive roles ${rolesForHolder.join(", ")} to standings holder ${holderId}; skipping exchanges that require those roles`,
    );

    rolesForHolder.forEach((role) => {
      resolvedRoles[role].validStanding = false;
    });
  });

  roleNames.forEach((role) => {
    const resolved = resolvedRoles[role];

    if (!resolved.validStanding) return;

    resolved.player =
      room.find((player) => player.id === resolved.standing.id) || null;
  });

  return resolvedRoles;
}

// Kicks off a new round once everyone has clicked Play Again: deals
// fresh hands, gives players a moment to see them, runs the automatic
// swap, then starts the card-by-card request phases (President asks
// the Asshole, then Vice President asks the Vice Asshole).
function startNewRound(roomCode) {
  const room = rooms[roomCode];

  // This function is the final authority for the transition. RESULTS
  // is consumed before any dealing occurs, so duplicate socket events
  // or another caller cannot enter this work twice.
  if (
    !room ||
    room.phase !== ROOM_PHASES.RESULTS ||
    !allRoomMembersReady(room)
  ) {
    return false;
  }

  // Every current room member is activated and dealt into the next round.
  // Refuse an invalid legacy/externally corrupted room before consuming the
  // RESULTS phase so no participant can begin with an empty hand.
  if (!canDealEveryRoomMember(room)) {
    io.to(roomCode).emit("errorMessage", ROOM_FULL_ERROR);
    return false;
  }

  clearExchangeActionTimeout(room);
  room.phase = ROOM_PHASES.EXCHANGE;

  // Readiness belongs to the completed Results phase. Consume it now,
  // rather than waiting for exchange/finalization, so it cannot trigger
  // another deal while the human exchange is still in progress.
  room.readyPlayers = new Set();

  // EXCHANGE has a fresh deal but no live turn or table yet. Retire the
  // completed round's play state immediately so existing clients and
  // late exchange-phase spectators cannot receive a stale pile/turn.
  room.table = [];
  resetPassedPlayers(room);
  room.currentTurnId = null;
  room.lastPlayedId = null;

  // Anyone who joined mid-round as a spectator is a full player again
  // starting now - they'll get dealt a hand just like everyone else
  room.forEach((player) => {
    player.spectator = false;
  });

  snapshotRoundPopulation(room);

  const prevRankings = room.finishedPlayers || [];

  const totalPlayers = room.length;

  const resolvedRoles = resolvePreviousRoundExchangeRoles(
    roomCode,
    room,
    prevRankings,
    totalPlayers > 4,
  );

  // A unique finalized role-holder who left before the new deal has no live
  // player here. Preserve the existing behavior by skipping only the pairing
  // that requires them rather than inventing a replacement.
  const president = resolvedRoles.President.player;
  const asshole = resolvedRoles.Asshole.player;
  const vicePresident =
    totalPlayers > 4 ? resolvedRoles["Vice President"].player : null;
  const viceAsshole =
    totalPlayers > 4 ? resolvedRoles["Vice Asshole"].player : null;

  // From the second round onward, the previous round's Asshole leads
  // the new round instead of whoever holds the 7 of hearts
  room.previousAsshole = asshole ? asshole.id : null;

  dealHands(room);

  // Show everyone their freshly dealt hand before anything gets
  // swapped around
  room.forEach((player) => {
    io.to(player.id).emit("yourCards", player.hand);
  });

  broadcastRoom(roomCode, room);

  const paValid =
    !!president && !!asshole && president.id !== asshole.id;

  const vaValid =
    totalPlayers > 4 &&
    !!vicePresident &&
    !!viceAsshole &&
    vicePresident.id !== viceAsshole.id;

  if (!paValid && !vaValid) {
    finalizeNewRound(roomCode);

    return true;
  }

  autoExchange(room, {
    president: paValid ? president : null,
    asshole: paValid ? asshole : null,
    vicePresident: vaValid ? vicePresident : null,
    viceAsshole: vaValid ? viceAsshole : null,
  });

  // Send hands again now that the automatic swap has happened
  room.forEach((player) => {
    io.to(player.id).emit("yourCards", player.hand);
  });

  broadcastRoom(roomCode, room);

  room.exchangeQueue = [];

  if (paValid) {
    const requestCountPA = totalPlayers > 4 ? 2 : 1;

    room.exchangeQueue.push(
      buildExchangeStage(president, asshole, requestCountPA),
    );
  }

  // Vice President gets the same request-a-card treatment against
  // the Vice Asshole, one card, once the main exchange is done
  if (vaValid) {
    room.exchangeQueue.push(
      buildExchangeStage(vicePresident, viceAsshole, 1),
    );
  }

  startExchangePhase(roomCode);

  return true;
}

// Kicks off the next exchange stage in the queue (President <-> Asshole
// first, then Vice President <-> Vice Asshole), or finalizes the round
// once the queue is empty
function startExchangePhase(roomCode) {
  const room = rooms[roomCode];

  if (!room || room.phase !== ROOM_PHASES.EXCHANGE) return;

  clearExchangeActionTimeout(room);

  if (!room.exchangeQueue || room.exchangeQueue.length === 0) {
    room.pendingRequest = null;

    finalizeNewRound(roomCode);

    return;
  }

  const stage = room.exchangeQueue[0];

  room.pendingRequest = stage;

  io.to(roomCode).emit("exchangeInProgress", {
    requesterUsername: stage.requesterUsername,
    responderUsername: stage.responderUsername,
  });

  promptNextCardRequest(roomCode);
}

// Asks the current requester (President, then Vice President) to pick
// the next rank to request, or advances the queue to the next stage
// once this stage's requests have all been made
function promptNextCardRequest(roomCode) {
  const room = rooms[roomCode];

  if (
    !room ||
    room.phase !== ROOM_PHASES.EXCHANGE ||
    !room.pendingRequest
  ) {
    return;
  }

  const exchange = room.pendingRequest;

  if (exchange.requestsMade >= exchange.totalRequests) {
    room.exchangeQueue.shift();

    room.pendingRequest = null;

    startExchangePhase(roomCode);

    return;
  }

  io.to(exchange.requesterId).emit("chooseCardRequest", {
    requestNumber: exchange.requestsMade + 1,
    totalRequests: exchange.totalRequests,
  });

  scheduleExchangeActionTimeout(
    roomCode,
    room,
    exchange,
    EXCHANGE_ACTIONS.RANK_REQUEST,
  );
}

function promptRequesterToReturnCard(exchange) {
  io.to(exchange.requesterId).emit("chooseCardToReturn", {
    responderUsername: exchange.responderUsername,
  });
}

function finalizeNewRound(roomCode) {
  const room = rooms[roomCode];

  if (!room || room.phase !== ROOM_PHASES.EXCHANGE) return false;

  clearExchangeActionTimeout(room);

  // Consume EXCHANGE before emitting or rebuilding live-round state so
  // a delayed duplicate queue callback cannot finalize the round twice.
  room.phase = ROOM_PHASES.PLAYING;

  room.readyPlayers = new Set();

  room.pendingRequest = null;

  room.exchangeQueue = [];

  room.forEach((player) => {
    player.finished = false;

    player.rank = null;
    player.finishPosition = null;
  });

  room.table = [];

  resetPassedPlayers(room);

  room.finishedPlayers = [];

  let startingPlayerIndex = -1;

  // From the second round onward, the previous round's Asshole starts
  if (room.previousAsshole) {
    startingPlayerIndex = room.findIndex(
      (player) => player.id === room.previousAsshole,
    );
  }

  // First round, or the previous Asshole isn't in the room anymore -
  // fall back to whoever holds the 7 of hearts
  if (startingPlayerIndex === -1) {
    startingPlayerIndex = room.findIndex((player) =>
      player.hand.some((card) => card.rank === "7" && card.suit === "♥"),
    );
  }

  if (startingPlayerIndex === -1) {
    startingPlayerIndex = 0;
  }

  room.currentTurnId = room[startingPlayerIndex].id;

  room.lastPlayedId = room[startingPlayerIndex].id;

  broadcastRoom(roomCode, room);

  room.forEach((player) => {
    io.to(player.id).emit("yourCards", player.hand);
  });

  io.to(roomCode).emit("turnUpdate", {
    playerId: room[startingPlayerIndex].id,
  });

  io.to(roomCode).emit("gameStarted");

  return true;
}

// Removes any exchange stage(s) that involve this player. A stage is
// only cancelled if the leaving player is one of its two concerned
// participants (President/Asshole, or Vice President/Vice Asshole) -
// an unrelated stage is left untouched and still takes place.
// Returns true if the currently active stage was the one cancelled.
function cancelExchangesInvolvingPlayer(room, playerId) {
  if (room.phase !== ROOM_PHASES.EXCHANGE) return false;

  if (!room.exchangeQueue) {
    room.exchangeQueue = [];
  }

  const activeStageCancelled =
    !!room.pendingRequest &&
    (room.pendingRequest.requesterId === playerId ||
      room.pendingRequest.responderId === playerId);

  room.exchangeQueue = room.exchangeQueue.filter(
    (stage) =>
      stage.requesterId !== playerId && stage.responderId !== playerId,
  );

  if (activeStageCancelled) {
    clearExchangeActionTimeout(room);
    room.pendingRequest = null;
  }

  return activeStageCancelled;
}

// Shared by both the explicit "leaveRoom" exit button and a socket
// disconnect - removes the player from the room, cancels only the
// exchange stage(s) they were directly involved in, and lets any
// unrelated stage still take place.
// Steps forward through the room in seating order starting after
// fromId, skipping the excluded player plus anyone finished or
// spectating, and returns the id of the next eligible player (or null
// if there isn't one). Used to hand the turn off correctly when the
// player who currently holds it leaves.
function getNextActiveId(room, fromId, excludeId) {
  const fromIndex = room.findIndex((p) => p.id === fromId);

  if (fromIndex === -1 || room.length === 0) {
    return null;
  }

  for (let step = 1; step <= room.length; step++) {
    const candidate = room[(fromIndex + step) % room.length];

    if (
      candidate &&
      candidate.id !== excludeId &&
      !candidate.finished &&
      !candidate.spectator
    ) {
      return candidate.id;
    }
  }

  return null;
}

function getPassedPlayerIds(room) {
  if (!(room.passedPlayerIds instanceof Set)) {
    room.passedPlayerIds = new Set();
  }

  return room.passedPlayerIds;
}

function resetPassedPlayers(room) {
  room.passedPlayerIds = new Set();
}

// Clears the current pile only after every connected, unfinished,
// non-spectating player other than the actual last player has passed. If the
// last player left, every remaining eligible player must have passed and the
// current turn holder starts the fresh pile.
function clearPileIfAllRequiredPlayersPassed(room) {
  const activePlayers = room.filter(
    (player) => !player.finished && !player.spectator,
  );

  if (activePlayers.length === 0) return null;

  const recordedLastPlayerIndex = room.findIndex(
    (player) => player.id === room.lastPlayedId,
  );
  const lastPlayer = activePlayers.find(
    (player) => player.id === room.lastPlayedId,
  );
  const requiredPlayers = lastPlayer
    ? activePlayers.filter((player) => player.id !== lastPlayer.id)
    : activePlayers;
  const passedPlayerIds = getPassedPlayerIds(room);

  if (!requiredPlayers.every((player) => passedPlayerIds.has(player.id))) {
    return null;
  }

  const fallbackLeader = activePlayers.find(
    (player) => player.id === room.currentTurnId,
  );
  let nextLeader = lastPlayer;

  // Preserve the existing normal-clear rule when the real pile owner is
  // still seated but has finished: the next eligible seat after them leads.
  if (!nextLeader && recordedLastPlayerIndex !== -1) {
    for (let step = 1; step <= room.length; step += 1) {
      const candidate = room[(recordedLastPlayerIndex + step) % room.length];

      if (!candidate.finished && !candidate.spectator) {
        nextLeader = candidate;
        break;
      }
    }
  }

  nextLeader ||= fallbackLeader || activePlayers[0];

  room.table = [];
  resetPassedPlayers(room);
  room.currentTurnId = nextLeader.id;

  return nextLeader.id;
}

// Resolves every membership change that leaves fewer than two current-round
// players. Finished/ranked players still count here: they remain participants
// in that round, so normal finishing must never be mistaken for abandonment.
// Returns true when it terminated the room or reset it to WAITING.
function handleInsufficientActivePlayers(roomCode, room) {
  const activePlayers = room.filter((player) => !player.spectator);
  const spectators = room.filter((player) => player.spectator);

  if (activePlayers.length >= 2) return false;

  // A normal one-person WAITING lobby remains available for someone else to
  // join. If usable spectators remain, however, normalize the lobby below so
  // it has one real active host rather than a host-only spectator.
  if (room.phase === ROOM_PHASES.WAITING && spectators.length === 0) {
    return false;
  }

  // Outside WAITING, one remaining active member with nobody available to
  // join the next game cannot continue. Old President/Asshole roles do not
  // keep this otherwise-dead room alive.
  if (spectators.length === 0) {
    terminateRoom(roomCode, room);
    return true;
  }

  // Spectators make the room recoverable. Keep the sole active player as
  // host when present; otherwise deterministically promote the earliest
  // spectator (room order is join order).
  const nextHost = activePlayers[0] || spectators[0];

  clearExchangeActionTimeout(room);
  room.phase = ROOM_PHASES.WAITING;
  room.currentTurnId = null;
  room.lastPlayedId = null;
  room.table = [];
  resetPassedPlayers(room);
  room.pendingRequest = null;
  room.exchangeQueue = [];
  room.finishedPlayers = [];
  room.previousAsshole = null;
  room.readyPlayers = new Set();
  room.roundParticipantIds = Object.freeze([]);
  room.roundParticipantCount = 0;
  room.roundWithdrawals = [];

  room.forEach((player) => {
    player.host = player === nextHost;
    player.hand = [];
    player.finished = false;
    player.rank = null;
    player.finishPosition = null;

    if (player === nextHost) {
      player.spectator = false;
    }

    io.to(player.id).emit("yourCards", []);
  });

  broadcastRoom(roomCode, room);
  return true;
}

function terminateRoom(roomCode, room) {
  clearExchangeActionTimeout(room);

  room.forEach((player) => {
    clearPlayerSession(player, roomCode);
    clearSocketRoomMembership(player.id, roomCode);

    io.to(player.id).emit(
      "errorMessage",
      "The room was closed because there are not enough players to continue.",
    );
    io.to(player.id).emit("yourCards", []);
    io.to(player.id).emit("updateRoom", { roomCode: "", players: [] });

    const playerSocket = io.sockets.sockets.get(player.id);
    playerSocket?.leave(roomCode);
  });

  delete rooms[roomCode];
}

function removePlayerFromRoom(roomCode, playerId) {
  const room = rooms[roomCode];

  if (!room) return;

  const leavingPlayer = room.find((p) => p.id === playerId);

  if (!leavingPlayer) return;

  clearPlayerSession(leavingPlayer, roomCode);

  trackRoundWithdrawal(room, leavingPlayer);

  clearSocketRoomMembership(playerId, roomCode);

  const activeStageCancelled = cancelExchangesInvolvingPlayer(room, playerId);

  const wasHost = leavingPlayer.host;

  // Figure out who inherits the turn / "last played" marker BEFORE
  // filtering, using the old (still complete) seating order - ids
  // stay valid once the array shrinks, so this is the only place that
  // needs to reason about the leaving player's position at all
  let nextCurrentTurnId = room.currentTurnId;

  if (room.currentTurnId === playerId) {
    nextCurrentTurnId = getNextActiveId(room, playerId, playerId);
  }

  let nextLastPlayedId = room.lastPlayedId;

  if (room.lastPlayedId === playerId) {
    // The pile owner left. Keep that historical fact honest instead of
    // pretending the next turn holder made the play that is on the table.
    nextLastPlayedId = null;
  }

  rooms[roomCode] = room.filter((p) => p.id !== playerId);

  const updatedRoom = rooms[roomCode];

  if (updatedRoom.length === 0) {
    clearExchangeActionTimeout(room);
    delete rooms[roomCode];

    return;
  }

  // Carry over the room's extra (non-array) state, since reassigning
  // rooms[roomCode] to a fresh filtered array loses it
  updatedRoom.currentTurnId = nextCurrentTurnId;
  updatedRoom.lastPlayedId = nextLastPlayedId;
  updatedRoom.table = room.table;
  updatedRoom.passedPlayerIds = getPassedPlayerIds(room);
  updatedRoom.passedPlayerIds.delete(playerId);
  updatedRoom.finishedPlayers = room.finishedPlayers;
  updatedRoom.pendingRequest = room.pendingRequest;
  updatedRoom.exchangeQueue = room.exchangeQueue;
  updatedRoom.previousAsshole = room.previousAsshole;
  updatedRoom.readyPlayers = room.readyPlayers;
  updatedRoom.phase = room.phase;
  updatedRoom.roundParticipantIds = room.roundParticipantIds;
  updatedRoom.roundParticipantCount = room.roundParticipantCount;
  updatedRoom.roundWithdrawals = room.roundWithdrawals;
  updatedRoom.exchangeActionTimer = room.exchangeActionTimer;
  updatedRoom.exchangeActionDeadline = room.exchangeActionDeadline;
  updatedRoom.exchangeActionPausedRemainingMs =
    room.exchangeActionPausedRemainingMs;
  updatedRoom.exchangeActionType = room.exchangeActionType;
  updatedRoom.exchangeActionToken = room.exchangeActionToken;

  // Now that readyPlayers has actually been carried onto the live
  // room object, drop the leaving player's ready vote (if any) - this
  // has to happen after the carry-over above, not before it
  if (updatedRoom.readyPlayers) {
    updatedRoom.readyPlayers.delete(playerId);
  }

  if (handleInsufficientActivePlayers(roomCode, updatedRoom)) return;

  // The host left - hand the crown to whoever's been in the room
  // longest so the lobby never gets soft-locked with no one able to
  // start the game
  if (wasHost && !updatedRoom.some((p) => p.host)) {
    const nextHost =
      updatedRoom.find((player) => !player.spectator) || updatedRoom[0];

    nextHost.host = true;
    nextHost.spectator = false;
  }

  if (finishRoundIfReady(roomCode, updatedRoom)) return;

  const pileLeaderId =
    updatedRoom.phase === ROOM_PHASES.PLAYING
      ? clearPileIfAllRequiredPlayersPassed(updatedRoom)
      : null;

  broadcastRoom(roomCode, updatedRoom);

  // Someone exited while the room was on the results screen waiting
  // for everyone to click Play Again. Re-sync the ready count against
  // the smaller room, and if that now means every remaining player is
  // ready, start the round instead of leaving them stuck waiting on
  // someone who's no longer here.
  if (updatedRoom.phase === ROOM_PHASES.RESULTS) {
    const readyPlayers = getReadyPlayers(updatedRoom);

    io.to(roomCode).emit("readyUpdate", {
      count: readyPlayers.size,
      total: getRoomMemberIds(updatedRoom).size,
    });

    if (allRoomMembersReady(updatedRoom)) {
      startNewRound(roomCode);
    }
  }

  if (pileLeaderId) {
    io.to(roomCode).emit("tableUpdate", {
      table: [],
      nextPlayer: pileLeaderId,
    });

    io.to(roomCode).emit("turnUpdate", { playerId: pileLeaderId });
  } else if (
    updatedRoom.phase === ROOM_PHASES.PLAYING &&
    room.currentTurnId === playerId &&
    nextCurrentTurnId
  ) {
    // The turn holder left mid-round - let the room know whose turn
    // it is now instead of leaving everyone waiting on a ghost
    io.to(roomCode).emit("turnUpdate", { playerId: nextCurrentTurnId });
  }

  if (activeStageCancelled && updatedRoom.phase === ROOM_PHASES.EXCHANGE) {
    // Let anyone with a stale request/offer/return prompt for the
    // cancelled stage clear it, then move on to the next stage (if
    // the other pair is unaffected, their exchange still happens) or
    // finalize the round if nothing is left in the queue
    io.to(roomCode).emit("exchangeStageCancelled");

    startExchangePhase(roomCode);
  }
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // RECOVER AN EXISTING PLAYER SESSION

  socket.on("recoverSession", (payload, acknowledge) => {
    const fail = () => {
      if (typeof acknowledge === "function") {
        acknowledge({ ok: false });
      }
      socket.emit("sessionRecoveryFailed");
    };

    if (
      !hasPayloadShape(payload, ["roomCode", "sessionToken"]) ||
      !isValidRoomCode(payload.roomCode) ||
      !isValidSessionToken(payload.sessionToken)
    ) {
      fail();
      return;
    }

    const { roomCode, sessionToken } = payload;
    const session = playerSessions.get(sessionToken);
    const room = rooms[roomCode];

    if (!session || session.roomCode !== roomCode || !room) {
      fail();
      return;
    }

    const existingMembership = getSocketRoomMembership(socket.id);
    if (existingMembership) {
      // A socket that already owns a different seat cannot use a token to
      // take over another one. Replaying recovery for its own seat is safe.
      if (existingMembership.player.sessionToken !== sessionToken) {
        fail();
        return;
      }

      syncExistingRoomMembership(socket, existingMembership);
      socket.emit("sessionRecovered", {
        roomCode,
        ready: getReadyPlayers(room).has(socket.id),
      });
      if (typeof acknowledge === "function") acknowledge({ ok: true });
      return;
    }

    const player = room.find(
      (candidate) => candidate.sessionToken === sessionToken,
    );

    if (!player) {
      playerSessions.delete(sessionToken);
      clearDisconnectTimer(sessionToken);
      fail();
      return;
    }

    const oldSocketId = player.id;
    const oldSocket = io.sockets.sockets.get(oldSocketId);

    // Newest valid claimant wins. This handles two tabs without ever
    // creating a second seat: all authoritative references are rebound
    // before the previous transport is disconnected.
    clearDisconnectTimer(sessionToken);
    clearSocketRoomMembership(oldSocketId, roomCode);
    oldSocket?.emit("sessionReplaced");
    oldSocket?.leave(roomCode);

    rebindPlayerSocketId(room, player, oldSocketId, socket.id);
    socketRoomCodes.set(socket.id, roomCode);
    playerSessions.set(sessionToken, { roomCode, playerId: socket.id });
    resumeExchangeActionTimeout(roomCode, room);

    socket.join(roomCode);
    broadcastRoom(roomCode, room);

    // Rebinding a transport ID also changes the authoritative turn holder ID.
    // updateRoom intentionally contains no turn state, so every PLAYING client
    // needs this room-wide projection immediately rather than waiting for the
    // recovered player to act. This reports the same turn; it never advances it.
    if (room.phase === ROOM_PHASES.PLAYING) {
      io.to(roomCode).emit("turnUpdate", {
        playerId: room.currentTurnId || null,
      });
    }

    syncExistingRoomMembership(socket, { roomCode, room, player });
    socket.emit("sessionRecovered", {
      roomCode,
      ready: getReadyPlayers(room).has(socket.id),
    });

    if (typeof acknowledge === "function") acknowledge({ ok: true });

    if (oldSocket && oldSocket.id !== socket.id) {
      oldSocket.disconnect?.(true);
    }
  });

  // CREATE ROOM

  socket.on("createRoom", (payload) => {
    if (
      !hasPayloadShape(payload, ["username"], ["avatar"]) ||
      !isValidUsername(payload.username) ||
      !isValidAvatar(payload.avatar)
    ) {
      rejectInvalidPayload(socket, "create room");
      return;
    }

    const { username, avatar } = payload;
    const existingMembership = getSocketRoomMembership(socket.id);

    if (existingMembership) {
      if (!existingMembership.player.host) {
        socket.emit(
          "errorMessage",
          "You are already in a room. Leave it before creating another.",
        );
      }

      syncExistingRoomMembership(socket, existingMembership);
      return;
    }

    let roomCode = generateRoomCode();

    while (!isValidRoomCode(roomCode) || rooms[roomCode]) {
      roomCode = generateRoomCode();
    }

    const hostPlayer = {
        id: socket.id,
        username,
        avatar: avatar || null,
        host: true,
        hand: [],
        finished: false,
        rank: null,
      };

    rooms[roomCode] = [hostPlayer];

    rooms[roomCode].phase = ROOM_PHASES.WAITING;
    rooms[roomCode].roundParticipantIds = Object.freeze([]);
    rooms[roomCode].roundParticipantCount = 0;
    rooms[roomCode].roundWithdrawals = [];
    rooms[roomCode].passedPlayerIds = new Set();

    socketRoomCodes.set(socket.id, roomCode);
    createPlayerSession(roomCode, hostPlayer);

    socket.join(roomCode);

    emitSessionCredentials(socket, roomCode, hostPlayer);

    socket.emit("roomCreated", {
      roomCode,
      phase: rooms[roomCode].phase,
      players: sanitizeRoom(rooms[roomCode]),
    });

    console.log("Room created:", roomCode);
  });

  // JOIN ROOM

  socket.on("joinRoom", (payload) => {
    if (
      !hasPayloadShape(payload, ["roomCode", "username"], ["avatar"]) ||
      !isValidUsername(payload.username) ||
      !isValidAvatar(payload.avatar)
    ) {
      rejectInvalidPayload(socket, "join room");
      return;
    }

    const roomCode = normalizeJoinRoomCode(payload.roomCode);

    if (!roomCode) {
      rejectInvalidPayload(socket, "join room");
      return;
    }

    const { username, avatar } = payload;
    const existingMembership = getSocketRoomMembership(socket.id);

    if (existingMembership) {
      if (existingMembership.roomCode !== roomCode) {
        socket.emit(
          "errorMessage",
          "You are already in a room. Leave it before joining another.",
        );
      }

      syncExistingRoomMembership(socket, existingMembership);
      return;
    }

    if (!rooms[roomCode]) {
      socket.emit("errorMessage", "Room does not exist");

      return;
    }

    const room = rooms[roomCode];

    // Capacity includes spectators because every spectator is promoted and
    // dealt in at the next round. Existing same-room replays returned above
    // remain idempotent even when the room is already full.
    if (room.length >= MAX_ROOM_CAPACITY) {
      socket.emit("errorMessage", ROOM_FULL_ERROR);
      return;
    }

    // A deal has already happened in PLAYING and EXCHANGE, so a new
    // arrival must wait as a spectator. WAITING and RESULTS arrivals
    // are eligible for the next deal as normal players.
    const joiningMidRound =
      room.phase === ROOM_PHASES.PLAYING ||
      room.phase === ROOM_PHASES.EXCHANGE;

    const joinedPlayer = {
      id: socket.id,
      username,
      avatar: avatar || null,
      host: false,
      hand: [],
      finished: false,
      rank: null,
      spectator: joiningMidRound,
    };

    room.push(joinedPlayer);

    socketRoomCodes.set(socket.id, roomCode);
    createPlayerSession(roomCode, joinedPlayer);

    socket.join(roomCode);
    emitSessionCredentials(socket, roomCode, joinedPlayer);

    // A late spectator may be the first usable second member to arrive after
    // a room was already reduced to one active player. Normalize that invalid
    // live round immediately instead of preserving an unplayable PLAYING or
    // EXCHANGE state merely because no departure happened in this callback.
    if (handleInsufficientActivePlayers(roomCode, room)) {
      console.log(username, "joined", roomCode);
      return;
    }

    broadcastRoom(roomCode, room);

    // Any non-waiting phase uses the existing game-screen event contract.
    // The explicit phase decides which additional snapshot is required.
    if (room.phase !== ROOM_PHASES.WAITING) {
      socket.emit("gameStarted");

      socket.emit("tableUpdate", {
        table: room.table || [],
        nextPlayer: room.currentTurnId || null,
      });

      if (
        room.phase === ROOM_PHASES.RESULTS ||
        room.phase === ROOM_PHASES.EXCHANGE
      ) {
        socket.emit("gameFinished", {
          rankings: sanitizeFinishedPlayers(room.finishedPlayers),
        });
      }

      if (room.phase === ROOM_PHASES.RESULTS) {
        const readyPlayers = getReadyPlayers(room);

        io.to(roomCode).emit("readyUpdate", {
          count: readyPlayers.size,
          total: getRoomMemberIds(room).size,
        });
      }

      if (room.phase === ROOM_PHASES.EXCHANGE && room.pendingRequest) {
        socket.emit("exchangeInProgress", {
          requesterUsername: room.pendingRequest.requesterUsername,
          responderUsername: room.pendingRequest.responderUsername,
        });
      }
    }

    console.log(username, "joined", roomCode);
  });

  // START GAME

  socket.on("startGame", (payload) => {
    if (!isValidRoomCode(payload)) {
      rejectInvalidPayload(socket, "start game");
      return;
    }

    const roomCode = payload;
    const room = rooms[roomCode];

    if (!room) return;

    const player = room.find((p) => p.id === socket.id);

    if (
      !player ||
      !player.host ||
      player.spectator ||
      room.phase !== ROOM_PHASES.WAITING
    ) {
      return;
    }

    // WAITING may legitimately contain a sole host, but a multiplayer round
    // may not start until a second distinct room member is available. Existing
    // Start behavior will activate any waiting spectators before the deal.
    if (getRoomMemberIds(room).size < 2) {
      socket.emit(
        "errorMessage",
        "At least two players are required to start the game.",
      );
      return;
    }

    if (!canDealEveryRoomMember(room)) {
      socket.emit("errorMessage", ROOM_FULL_ERROR);
      return;
    }

    // Consume WAITING before dealing so duplicate Start events cannot
    // redeal or reset an already-starting round.
    clearExchangeActionTimeout(room);
    room.phase = ROOM_PHASES.PLAYING;

    snapshotRoundPopulation(room);

    dealHands(room);

    room.forEach((player) => {
      player.finished = false;

      player.rank = null;
      player.finishPosition = null;

      player.spectator = false;

      io.to(player.id).emit("yourCards", player.hand);
    });

    room.table = [];

    resetPassedPlayers(room);

    room.finishedPlayers = [];

    room.pendingRequest = null;

    room.exchangeQueue = [];

    room.previousAsshole = null;

    room.readyPlayers = new Set();

    let startingPlayerIndex = room.findIndex((player) =>
      player.hand.some((card) => card.rank === "7" && card.suit === "♥"),
    );

    if (startingPlayerIndex === -1) {
      startingPlayerIndex = 0;
    }

    room.currentTurnId = room[startingPlayerIndex].id;

    room.lastPlayedId = room[startingPlayerIndex].id;

    broadcastRoom(roomCode, room);

    io.to(roomCode).emit("turnUpdate", {
      playerId: room[startingPlayerIndex].id,
    });

    io.to(roomCode).emit("gameStarted");

    console.log(
      "Game started:",
      roomCode,
      "Starting player:",
      room[startingPlayerIndex].username,
    );
  });

  // PLAY CARDS

  // PLAY CARDS

  // PLAY CARDS

  socket.on("playCards", (payload) => {
    if (
      !hasPayloadShape(payload, ["roomCode", "cards"]) ||
      !isValidRoomCode(payload.roomCode) ||
      !isValidPlayedCards(payload.cards)
    ) {
      rejectInvalidPayload(socket, "play cards");
      return;
    }

    const { roomCode, cards } = payload;
    const room = rooms[roomCode];

    if (!room) return;

    if (room.phase !== ROOM_PHASES.PLAYING) {
      socket.emit(
        "errorMessage",
        "You can't play right now",
      );

      return;
    }

    const playerIndex = room.findIndex((p) => p.id === socket.id);

    if (playerIndex === -1) return;

    if (room.currentTurnId !== socket.id) {
      socket.emit("errorMessage", "Not your turn");

      return;
    }

    const player = room[playerIndex];

    if (!isValidSet(cards)) {
      socket.emit(
        "errorMessage",
        "You can only play up to 4 cards of the same rank",
      );

      return;
    }

    if (!handContainsCards(player.hand, cards)) {
      socket.emit("errorMessage", "You don't have those cards");

      return;
    }

    if (room.table.length > 0) {
      // A bomb can land on top of any play, whatever size it is - the
      // count restriction only applies to non-bomb plays
      if (!isBomb(cards) && cards.length !== room.table.length) {
        socket.emit("errorMessage", "You must play the same number of cards");

        return;
      }

      let currentValue = getPlayValue(room.table);

      let newValue = getPlayValue(cards);

      if (newValue <= currentValue) {
        socket.emit("errorMessage", "Your cards are too low");

        return;
      }
    }

    // 1. Remove played cards from hand
    player.hand = player.hand.filter(
      (card) =>
        !cards.some((c) => c.rank === card.rank && c.suit === card.suit),
    );

    room.table = cards;

    room.lastPlayedId = player.id;

    resetPassedPlayers(room);

    // 2. Immediate check for zero cards in hand (Ace Trap for 1, 2, 3, or 4 Aces)
    if (player.hand.length === 0 && !player.finished) {
      const isAceTrap = cards[0].rank === "A"; // Valid for 1, 2, 3, or 4 Ace sets

      if (isAceTrap) {
        const claimedAssholeSlot = !hasRoundAsshole(room);

        assignFinisherRank(room, player, true);
        console.log(
          player.username,
          claimedAssholeSlot
            ? `triggered ACE TRAP with ${cards.length} Ace(s) and instantly became Asshole!`
            : `finished with ${cards.length} Ace(s) after the Asshole slot was already claimed`,
        );
      } else {
        assignFinisherRank(room, player, false);
        console.log(player.username, "finished as", player.rank);
      }

      broadcastPlayerFinished(roomCode, player);

      if (finishRoundIfReady(roomCode, room)) return;

      // Sync a non-terminal finisher immediately across all clients.
      broadcastRoom(roomCode, room);
    }

    // 3. Advance turn to the next active player
    let nextIndex = playerIndex;

    do {
      nextIndex = (nextIndex + 1) % room.length;
    } while (room[nextIndex].finished || room[nextIndex].spectator);

    room.currentTurnId = room[nextIndex].id;

    // Synchronize full room status and table update
    broadcastRoom(roomCode, room);

    io.to(roomCode).emit("tableUpdate", {
      table: room.table,
      nextPlayer: room[nextIndex].id,
      playedBy: player.id,
    });

    io.to(player.id).emit("yourCards", player.hand);
  });
  // PASS TURN

  socket.on("passTurn", (payload) => {
    if (!isValidRoomCode(payload)) {
      rejectInvalidPayload(socket, "pass turn");
      return;
    }

    const roomCode = payload;
    const room = rooms[roomCode];

    if (!room) return;

    if (room.phase !== ROOM_PHASES.PLAYING) {
      socket.emit(
        "errorMessage",
        "You can't pass right now",
      );

      return;
    }

    const playerIndex = room.findIndex((p) => p.id === socket.id);

    if (playerIndex === -1) return;

    const player = room[playerIndex];

    if (player.finished || player.spectator) {
      socket.emit("errorMessage", "You can't pass right now");
      return;
    }

    if (room.currentTurnId !== socket.id) {
      socket.emit("errorMessage", "Not your turn");

      return;
    }

    if (!Array.isArray(room.table) || room.table.length === 0) {
      socket.emit("errorMessage", "You can't pass on an empty table");
      return;
    }

    // A player's pass is an idempotent fact for this pile. Replayed socket
    // events cannot increase the pass state or take another player's chance.
    getPassedPlayerIds(room).add(socket.id);

    const pileLeaderId = clearPileIfAllRequiredPlayersPassed(room);

    if (pileLeaderId) {

      io.to(roomCode).emit("tableUpdate", {
        table: [],
        nextPlayer: pileLeaderId,
      });

      io.to(roomCode).emit("turnUpdate", {
        playerId: pileLeaderId,
      });

      return;
    }

    let nextIndex = playerIndex;

    do {
      nextIndex = (nextIndex + 1) % room.length;
    } while (room[nextIndex].finished || room[nextIndex].spectator);

    room.currentTurnId = room[nextIndex].id;

    io.to(roomCode).emit("turnUpdate", {
      playerId: room[nextIndex].id,
    });
  });

  // EXIT ROOM (explicit "Exit" button, as opposed to a disconnect)

  socket.on("leaveRoom", (payload) => {
    if (!isValidRoomCode(payload)) {
      rejectInvalidPayload(socket, "leave room");
      return;
    }

    const roomCode = payload;
    const membership = getSocketRoomMembership(socket.id);

    if (!membership || membership.roomCode !== roomCode) return;

    // Detach first so a WAITING-reset broadcast for the remaining members
    // cannot race the departing client's local Leave reset and put it back
    // into the room UI. Direct messages to the socket still use its id room.
    socket.leave(roomCode);

    removePlayerFromRoom(roomCode, socket.id);
  });

  // PLAY AGAIN

  socket.on("readyToPlayAgain", (payload) => {
    if (!isValidRoomCode(payload)) {
      rejectInvalidPayload(socket, "ready");
      return;
    }

    const roomCode = payload;
    const room = rooms[roomCode];

    if (!room || room.phase !== ROOM_PHASES.RESULTS) return;

    // A socket may only ready a seat it actually owns in this room.
    if (!getRoomMemberIds(room).has(socket.id)) return;

    // Repair/terminate any legacy or departure-edge RESULTS room before a
    // Ready vote can leave a lone ranked survivor displaying 1/1 forever.
    if (handleInsufficientActivePlayers(roomCode, room)) return;

    const readyPlayers = getReadyPlayers(room);

    // Socket.IO may deliver a user action more than once. Treat a
    // repeated Ready as a no-op rather than re-emitting or rechecking
    // a transition that this player already contributed to.
    if (readyPlayers.has(socket.id)) return;

    readyPlayers.add(socket.id);

    io.to(roomCode).emit("readyUpdate", {
      count: readyPlayers.size,
      total: getRoomMemberIds(room).size,
    });

    if (allRoomMembersReady(room)) {
      startNewRound(roomCode);
    }
  });

  // CURRENT REQUESTER PICKS A RANK TO ASK FOR (one card at a time) -
  // used by both the President (vs Asshole) and Vice President (vs
  // Vice Asshole) exchange stages, since they follow the same rules

  socket.on("requestCardFromAsshole", (payload) => {
    if (
      !hasPayloadShape(payload, ["roomCode", "rank"]) ||
      !isValidRoomCode(payload.roomCode) ||
      typeof payload.rank !== "string" ||
      !REQUESTABLE_RANKS.has(payload.rank)
    ) {
      rejectInvalidPayload(socket, "card request");
      return;
    }

    const { roomCode, rank } = payload;
    const room = rooms[roomCode];

    if (
      !room ||
      room.phase !== ROOM_PHASES.EXCHANGE ||
      !room.pendingRequest
    ) {
      return;
    }

    const exchange = room.pendingRequest;

    if (socket.id !== exchange.requesterId) return;

    if (exchange.pendingRank || exchange.awaitingReturn) return;

    const requester = room.find((p) => p.id === exchange.requesterId);

    const responder = room.find((p) => p.id === exchange.responderId);

    if (!requester || !responder) return;

    exchange.pendingRank = rank;

    clearExchangeActionTimeout(room);

    const responderHasCard = responder.hand.some((c) => c.rank === rank);

    io.to(exchange.responderId).emit("cardRequested", {
      rank,
      requesterUsername: requester.username,
      responderHasCard,
    });

    scheduleExchangeActionTimeout(
      roomCode,
      room,
      exchange,
      EXCHANGE_ACTIONS.CARD_RESPONSE,
    );
  });

  // RESPONDER SAYS YES OR NO TO THAT SPECIFIC CARD
  // They can say no even if they have it - but they can't say yes
  // if they genuinely don't have it, the server enforces that.

  socket.on("assholeRespondToRequest", (payload) => {
    if (
      !hasPayloadShape(payload, ["roomCode", "give"]) ||
      !isValidRoomCode(payload.roomCode) ||
      typeof payload.give !== "boolean"
    ) {
      rejectInvalidPayload(socket, "card response");
      return;
    }

    const { roomCode, give } = payload;
    const room = rooms[roomCode];

    if (
      !room ||
      room.phase !== ROOM_PHASES.EXCHANGE ||
      !room.pendingRequest
    ) {
      return;
    }

    const exchange = room.pendingRequest;

    if (socket.id !== exchange.responderId) return;

    if (!exchange.pendingRank) return;

    const requester = room.find((p) => p.id === exchange.requesterId);

    const responder = room.find((p) => p.id === exchange.responderId);

    if (!requester || !responder) return;

    if (give) {
      const index = responder.hand.findIndex(
        (c) => c.rank === exchange.pendingRank,
      );

      // They can't say yes to a card they don't actually have
      if (index === -1) {
        return;
      }

      clearExchangeActionTimeout(room);

      // Reserve the exact physical card, but do not mutate either hand yet.
      // The complete two-way swap is committed only after a valid return card
      // is selected and both participants are revalidated.
      const card = responder.hand[index];
      exchange.pendingTransferCard = {
        rank: card.rank,
        suit: card.suit,
      };
      exchange.pendingRank = null;
      exchange.awaitingReturn = true;

      promptRequesterToReturnCard(exchange);
      scheduleExchangeActionTimeout(
        roomCode,
        room,
        exchange,
        EXCHANGE_ACTIONS.RETURN_CARD,
      );

      return;
    }

    clearExchangeActionTimeout(room);
    exchange.pendingRank = null;
    exchange.pendingTransferCard = null;
    exchange.requestsMade += 1;

    promptNextCardRequest(roomCode);
  });

  // REQUESTER GIVES A CARD BACK FROM THEIR OWN HAND

  socket.on("returnCardToAsshole", (payload) => {
    if (
      !hasPayloadShape(payload, ["roomCode", "card"]) ||
      !isValidRoomCode(payload.roomCode) ||
      !isValidPhysicalCard(payload.card)
    ) {
      rejectInvalidPayload(socket, "return card");
      return;
    }

    const { roomCode, card } = payload;
    const room = rooms[roomCode];

    if (
      !room ||
      room.phase !== ROOM_PHASES.EXCHANGE ||
      !room.pendingRequest
    ) {
      return;
    }

    const exchange = room.pendingRequest;

    if (socket.id !== exchange.requesterId) return;

    if (
      !exchange.awaitingReturn ||
      !isValidPhysicalCard(exchange.pendingTransferCard)
    ) {
      return;
    }

    const requester = room.find((p) => p.id === exchange.requesterId);

    const responder = room.find((p) => p.id === exchange.responderId);

    if (
      !requester ||
      !responder ||
      requester.spectator ||
      responder.spectator ||
      requester.connected === false ||
      responder.connected === false
    ) {
      if (requester && requester.connected !== false) {
        promptRequesterToReturnCard(exchange);
      }
      return;
    }

    const returnIndex = requester.hand.findIndex(
      (c) => c.rank === card.rank && c.suit === card.suit,
    );

    const transferIndex = responder.hand.findIndex(
      (candidate) =>
        candidate.rank === exchange.pendingTransferCard.rank &&
        candidate.suit === exchange.pendingTransferCard.suit,
    );

    // Revalidate both sides immediately before mutation. A stale return
    // selection or a no-longer-owned requested card leaves the transaction
    // pending and both hands byte-for-byte unchanged.
    if (returnIndex === -1 || transferIndex === -1) {
      promptRequesterToReturnCard(exchange);
      return;
    }

    clearExchangeActionTimeout(room);

    const [returnedCard] = requester.hand.splice(returnIndex, 1);
    const [transferredCard] = responder.hand.splice(transferIndex, 1);

    responder.hand.push(returnedCard);
    requester.hand.push(transferredCard);

    // Consume the transaction before emitting. Duplicate return packets are
    // therefore no-ops even if they arrive immediately after this one.
    exchange.awaitingReturn = false;
    exchange.pendingTransferCard = null;
    exchange.requestsMade += 1;

    io.to(requester.id).emit("yourCards", requester.hand);

    io.to(responder.id).emit("yourCards", responder.hand);

    broadcastRoom(roomCode, room);

    promptNextCardRequest(roomCode);
  });

  // ================= DEBUG ONLY =================
  // Lets a connected client force themselves (and, where possible,
  // the rest of the room) directly into a specific end-of-round rank
  // so the President/Vice President exchange UI can be tested without
  // playing an entire round out. This does NOT introduce a separate
  // fake exchange system - it just populates room.finishedPlayers the
  // same way a real round-end does, then calls the exact same
  // startNewRound() used by "Play Again", so dealing, autoExchange,
  // and the request/return queue all run through their normal code
  // paths unchanged.
  socket.on("debugBecomeRank", (payload) => {
    // The client-side visibility flag is only a convenience. This server-side
    // opt-in is the security boundary, so production/manual socket events can
    // never enter the destructive debug pipeline unless explicitly enabled.
    if (!ENABLE_DEBUG_TOOLS) {
      socket.emit("errorMessage", "Debug tools are disabled");
      return;
    }

    if (
      !hasPayloadShape(payload, ["roomCode", "rank"]) ||
      !isValidRoomCode(payload.roomCode) ||
      typeof payload.rank !== "string" ||
      !DEBUG_RANKS.includes(payload.rank)
    ) {
      rejectInvalidPayload(socket, "debug rank");
      return;
    }

    const { roomCode, rank } = payload;
    const room = rooms[roomCode];

    if (!room) return;

    const clicker = room.find((p) => p.id === socket.id);

    if (!clicker) return;

    // Clear out any in-progress round/exchange state so this always
    // starts from a clean slate, regardless of what was happening
    // when the debug button was clicked.
    clearExchangeActionTimeout(room);
    room.pendingRequest = null;
    room.exchangeQueue = [];
    room.phase = ROOM_PHASES.RESULTS;
    room.readyPlayers = new Set();
    room.table = [];
    resetPassedPlayers(room);

    // Preserve the existing frontend event contract even though the
    // server now uses room.phase as its only lifecycle authority.
    io.to(roomCode).emit("gameStarted");

    // Give the clicking player the requested rank. The role that
    // actually exchanges cards with it (President<->Asshole,
    // Vice President<->Vice Asshole) is handed to the first other
    // connected player so the exchange is guaranteed to trigger with
    // as few as 2 players in the room; any further players fill the
    // remaining roles, and any players beyond that just finish with
    // no special role ("Nothing"), same as a normal mid-pack
    // finisher. If there aren't enough other players connected to
    // fill a pairing, that part of the exchange simply won't trigger
    // - identical to how a real game behaves with too few players.
    const partnerRole = {
      President: "Asshole",
      Asshole: "President",
      "Vice President": "Vice Asshole",
      "Vice Asshole": "Vice President",
    }[rank];

    const otherRoles = DEBUG_RANKS.filter(
      (r) => r !== rank && r !== partnerRole,
    );

    const rolesForOthers = [partnerRole, ...otherRoles];

    const others = room.filter((p) => p.id !== socket.id);

    room.forEach((p) => {
      p.finished = true;
      p.rank = null;
    });

    clicker.rank = rank;

    others.forEach((p, i) => {
      p.rank = i < rolesForOthers.length ? rolesForOthers[i] : null;
    });

    room.finishedPlayers = [...room];
    room.finishedPlayers.forEach((player, index) => {
      player.finishPosition = index + 1;
    });

    // Simulate the previous round having just ended with these ranks
    // - this is exactly what puts the results/exchange screens on the
    // client, the same "gameFinished" broadcast a real round end
    // sends once everyone but one player has finished.
    io.to(roomCode).emit("gameFinished", {
      rankings: sanitizeFinishedPlayers(room.finishedPlayers),
    });

    // The debug route deliberately skips individual Ready clicks, but
    // it still enters the same guarded RESULTS -> EXCHANGE transition.
    room.readyPlayers = new Set(room.map((player) => player.id));

    console.log(
      "[DEBUG]",
      clicker.username,
      "forced into rank",
      rank,
      "in room",
      roomCode,
    );

    // Skip the "waiting for everyone to click Play Again" step and go
    // straight into the exchange, using the exact same
    // startNewRound() pipeline "Play Again" uses.
    startNewRound(roomCode);
  });

  // DISCONNECT

  socket.on("disconnect", () => {
    const membership = getSocketRoomMembership(socket.id);

    if (membership) {
      const { roomCode, room, player } = membership;
      const { sessionToken } = player;

      player.connected = false;
      pauseExchangeActionTimeoutForPlayer(room, socket.id);
      clearSocketRoomMembership(socket.id, roomCode);
      broadcastRoom(roomCode, room);

      clearDisconnectTimer(sessionToken);
      const disconnectedPlayerId = socket.id;
      const timer = setTimeout(() => {
        disconnectTimers.delete(sessionToken);

        const activeSession = playerSessions.get(sessionToken);
        const currentRoom = rooms[roomCode];
        const reservedPlayer = currentRoom?.find(
          (candidate) => candidate.sessionToken === sessionToken,
        );

        if (
          !activeSession ||
          activeSession.roomCode !== roomCode ||
          activeSession.playerId !== disconnectedPlayerId ||
          !reservedPlayer ||
          reservedPlayer.id !== disconnectedPlayerId ||
          reservedPlayer.connected !== false
        ) {
          return;
        }

        removePlayerFromRoom(roomCode, disconnectedPlayerId);
      }, RECONNECT_GRACE_MS);

      disconnectTimers.set(sessionToken, timer);
    } else {
      socketRoomCodes.delete(socket.id);
    }

    console.log("Disconnected:", socket.id);
  });
});

server.listen(SERVER_PORT, () => {
  console.log(`Server running on port ${SERVER_PORT}`);
});
