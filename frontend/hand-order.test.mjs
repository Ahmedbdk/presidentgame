import assert from "node:assert/strict";
import fs from "node:fs";
import { reconcileHandOrder } from "./src/handOrder.js";

const card = (rank, suit) => ({ rank, suit });
const key = (value) => `${value.rank}-${value.suit}`;
const keys = (hand) => hand.map(key);

const threeClubs = card("3", "♣");
const fourSpades = card("4", "♠");
const fiveHearts = card("5", "♥");
const sixDiamonds = card("6", "♦");

const manualOrder = [fiveHearts, threeClubs, fourSpades];

// Playing/giving a card removes only that card and preserves every surviving
// card's relative manual position, regardless of the server array's order.
assert.deepStrictEqual(
  keys(reconcileHandOrder(manualOrder, [fourSpades, fiveHearts])),
  ["5-♥", "4-♠"],
);
assert.deepStrictEqual(
  keys(reconcileHandOrder(manualOrder, [fourSpades, threeClubs])),
  ["3-♣", "4-♠"],
);

// New exchange cards append without disturbing the existing custom order.
assert.deepStrictEqual(
  keys(
    reconcileHandOrder(manualOrder, [
      sixDiamonds,
      fourSpades,
      threeClubs,
      fiveHearts,
    ]),
  ),
  ["5-♥", "3-♣", "4-♠", "6-♦"],
);

// Repeated authoritative updates neither duplicate nor lose physical cards.
const firstUpdate = reconcileHandOrder(manualOrder, [
  fourSpades,
  fiveHearts,
  sixDiamonds,
]);
const secondUpdate = reconcileHandOrder(firstUpdate, [
  sixDiamonds,
  fourSpades,
  fiveHearts,
]);
assert.deepStrictEqual(keys(secondUpdate), ["5-♥", "4-♠", "6-♦"]);
assert.strictEqual(new Set(keys(secondUpdate)).size, secondUpdate.length);

// Wiring checks: a real drag enables preservation, Sort deliberately disables
// it and re-sorts, while WAITING/RESULTS reset it for the next fresh deal.
const appSource = fs.readFileSync(new URL("./src/App.jsx", import.meta.url), "utf8");
assert.match(appSource, /manualHandOrderRef\.current = true;\s*setHand\(newHand\)/);
assert.match(
  appSource,
  /manualHandOrderRef\.current = false;\s*setSortDirection\(next\);\s*setHand\(\(prev\) => sortHand\(prev, next\)\)/,
);
assert.match(
  appSource,
  /data\.phase === "WAITING" \|\| data\.phase === "RESULTS"/,
);
assert.match(
  appSource,
  /manualHandOrderRef\.current[\s\S]*?reconcileHandOrder\(previousHand, cards\)[\s\S]*?sortHand\(cards, sortDirectionRef\.current\)/,
);

console.log("Hand-order persistence tests passed.");
