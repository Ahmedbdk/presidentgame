const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadServerInternals() {
  const serverPath = path.join(__dirname, "server.js");
  const source = `${fs.readFileSync(serverPath, "utf8")}
module.exports = { autoExchange, lowestCards };`;

  class MockSocketServer {
    on() {}
    to() {
      return { emit() {} };
    }
  }

  const context = {
    module: { exports: {} },
    exports: {},
    setTimeout() { return {}; },
    clearTimeout() {},
    Set,
    Map,
    console,
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

  return context.module.exports;
}

const { autoExchange, lowestCards } = loadServerInternals();

function card(rank, suit) {
  return { rank, suit };
}

function player(id, hand) {
  return { id, hand };
}

function cardId(value) {
  return `${value.rank}${value.suit}`;
}

function sortedCardIds(cards) {
  return Array.from(cards, cardId).sort();
}

function roomCardIds(room) {
  return room.flatMap((member) => member.hand).map(cardId).sort();
}

function assertCardConservation(before, room) {
  const after = roomCardIds(room);

  assert.deepStrictEqual(after, before, "the exchange must conserve every card");
  assert.strictEqual(
    new Set(after).size,
    after.length,
    "the exchange must not duplicate a physical card",
  );
}

assert.deepStrictEqual(
  sortedCardIds(
    lowestCards(
      [card("A", "♠"), card("3", "♥"), card("K", "♦"), card("2", "♣")],
      2,
    ),
  ),
  ["2♣", "3♥"],
  "lowestCards must sort by ascending rank value",
);

for (const size of [2, 3, 4]) {
  const president = player("president", [card("A", "♠"), card("K", "♠")]);
  const asshole = player("asshole", [
    card("2", "♥"),
    card("Q", "♥"),
    card("10", "♥"),
  ]);
  const room = [president, asshole];

  while (room.length < size) {
    room.push(player(`filler-${room.length}`, [card("5", `f${room.length}`)]));
  }

  const before = roomCardIds(room);

  assert.strictEqual(autoExchange({ president, asshole }, size), true);
  assert.deepStrictEqual(sortedCardIds(president.hand), ["A♠", "K♠", "Q♥"].sort());
  assert.deepStrictEqual(sortedCardIds(asshole.hand), ["10♥", "2♥"].sort());
  assertCardConservation(before, room);
}

for (const size of [5, 6]) {
  const president = player("president", [
    card("A", "♠"),
    card("K", "♠"),
    card("Q", "♠"),
  ]);
  const asshole = player("asshole", [
    card("2", "♥"),
    card("3", "♥"),
    card("4", "♥"),
  ]);
  const vicePresident = player("vice-president", [
    card("A", "♦"),
    card("K", "♦"),
  ]);
  const viceAsshole = player("vice-asshole", [
    card("2", "♣"),
    card("3", "♣"),
  ]);
  const room = [president, asshole, vicePresident, viceAsshole];

  while (room.length < size) {
    room.push(player(`filler-${room.length}`, [card("6", `f${room.length}`)]));
  }

  const before = roomCardIds(room);

  assert.strictEqual(
    autoExchange({ president, asshole, vicePresident, viceAsshole }, size),
    true,
  );

  // The incoming 4/3 and 3 are lower than the receivers' original cards.
  // They must remain with the receivers because all outgoing selections were
  // made from the pre-transfer snapshots.
  assert.deepStrictEqual(sortedCardIds(president.hand), ["3♥", "4♥", "A♠"].sort());
  assert.deepStrictEqual(sortedCardIds(asshole.hand), ["2♥", "K♠", "Q♠"].sort());
  assert.deepStrictEqual(sortedCardIds(vicePresident.hand), ["3♣", "A♦"].sort());
  assert.deepStrictEqual(sortedCardIds(viceAsshole.hand), ["2♣", "K♦"].sort());
  assertCardConservation(before, room);
}

for (const previousSize of [2, 3, 4]) {
  for (const nextSize of [5, 6, 8]) {
    const president = player("president", [card("2", "S"), card("3", "S")]);
    const asshole = player("asshole", [card("K", "H"), card("Q", "H")]);
    const room = [president, asshole];

    while (room.length < nextSize) {
      room.push(player(`late-${room.length}`, [card("5", `f${room.length}`)]));
    }

    const before = roomCardIds(room);
    const untouchedHands = room.slice(2).map((member) => sortedCardIds(member.hand));

    assert.strictEqual(autoExchange({ president, asshole }, previousSize), true);
    assert.deepStrictEqual(sortedCardIds(president.hand), ["2S", "3S", "KH"]);
    assert.deepStrictEqual(sortedCardIds(asshole.hand), ["QH"]);
    assert.deepStrictEqual(
      room.slice(2).map((member) => sortedCardIds(member.hand)),
      untouchedHands,
    );
    assertCardConservation(before, room);
  }
}

for (const previousSize of [5, 6, 8]) {
  const president = player("president", [card("2", "S"), card("3", "S")]);
  const asshole = player("asshole", [card("K", "H"), card("Q", "H")]);
  const vicePresident = player("vice-president", [card("4", "D"), card("5", "D")]);
  const viceAsshole = player("vice-asshole", [card("J", "C"), card("10", "C")]);
  const room = [president, asshole, vicePresident, viceAsshole];
  const before = roomCardIds(room);

  assert.strictEqual(
    autoExchange({ president, asshole, vicePresident, viceAsshole }, previousSize),
    true,
  );
  assert.deepStrictEqual(sortedCardIds(president.hand), ["KH", "QH"]);
  assert.deepStrictEqual(sortedCardIds(asshole.hand), ["2S", "3S"]);
  assert.deepStrictEqual(sortedCardIds(vicePresident.hand), ["5D", "JC"]);
  assert.deepStrictEqual(sortedCardIds(viceAsshole.hand), ["10C", "4D"]);
  assertCardConservation(before, room);
}

console.log("Automatic exchange integration tests passed.");
