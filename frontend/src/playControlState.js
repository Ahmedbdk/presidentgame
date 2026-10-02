function isValidSet(cards) {
  return (
    Array.isArray(cards) &&
    cards.length >= 1 &&
    cards.length <= 4 &&
    cards.every((card) => card.rank === cards[0].rank)
  );
}

function isBomb(cards) {
  return isValidSet(cards) && cards.length === 4;
}

function playValue(cards, rankValues) {
  const rankValue = rankValues[cards[0].rank];
  return isBomb(cards) ? 100 + rankValue : rankValue;
}

export function selectionExistsInHand(hand, selectedCards) {
  if (!Array.isArray(hand) || !Array.isArray(selectedCards)) return false;

  const remaining = [...hand];

  for (const selectedCard of selectedCards) {
    const index = remaining.findIndex(
      (card) =>
        card.rank === selectedCard.rank && card.suit === selectedCard.suit,
    );

    if (index === -1) return false;
    remaining.splice(index, 1);
  }

  return true;
}

export function isExactSelectedPlayLegal(
  selectedCards,
  tableCards,
  rankValues,
) {
  if (!isValidSet(selectedCards)) return false;
  if (!Array.isArray(tableCards) || tableCards.length === 0) return true;

  if (!isBomb(selectedCards) && selectedCards.length !== tableCards.length) {
    return false;
  }

  return (
    playValue(selectedCards, rankValues) > playValue(tableCards, rankValues)
  );
}

export function canUsePlayControls({
  roomPhase,
  isPlayerPresent,
  isLocalTurn,
  isSpectator,
  isFinished,
}) {
  return (
    roomPhase === "PLAYING" &&
    isPlayerPresent &&
    isLocalTurn &&
    !isSpectator &&
    !isFinished
  );
}

export function canSubmitSelectedPlay({
  roomPhase,
  isPlayerPresent,
  isLocalTurn,
  isSpectator,
  isFinished,
  hand,
  selectedCards,
  tableCards,
  rankValues,
}) {
  return (
    canUsePlayControls({
      roomPhase,
      isPlayerPresent,
      isLocalTurn,
      isSpectator,
      isFinished,
    }) &&
    selectionExistsInHand(hand, selectedCards) &&
    isExactSelectedPlayLegal(selectedCards, tableCards, rankValues)
  );
}
