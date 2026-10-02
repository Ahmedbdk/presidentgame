function cardIdentity(card) {
  return `${card.rank}\u0000${card.suit}`;
}

// Reconcile presentation order against a complete authoritative server hand.
// Surviving cards follow the player's current UI order, removed cards vanish,
// and genuinely new cards are appended in the order supplied by the server.
export function reconcileHandOrder(previousHand, authoritativeHand) {
  const authoritativeByIdentity = new Map(
    authoritativeHand.map((card) => [cardIdentity(card), card]),
  );
  const retainedIdentities = new Set();
  const reconciled = [];

  previousHand.forEach((card) => {
    const identity = cardIdentity(card);
    const authoritativeCard = authoritativeByIdentity.get(identity);

    if (!authoritativeCard || retainedIdentities.has(identity)) return;

    retainedIdentities.add(identity);
    reconciled.push(authoritativeCard);
  });

  authoritativeHand.forEach((card) => {
    const identity = cardIdentity(card);

    if (retainedIdentities.has(identity)) return;

    retainedIdentities.add(identity);
    reconciled.push(card);
  });

  return reconciled;
}
