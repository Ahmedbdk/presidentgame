function cardIdentity(card) {
  return `${card.rank}:${card.suit}`;
}

export function createVisualPlayHistory() {
  return {
    groups: [],
    recordedPlayKeys: new Set(),
    nextGroupSequence: 0,
  };
}

export function recordVisualPlay(history, cards) {
  if (
    !history ||
    !Array.isArray(cards) ||
    cards.length === 0
  ) {
    return null;
  }

  // Physical rank+suit identities are unique within this deck and cannot be
  // legitimately played twice in one round. Using them as the action key also
  // deduplicates a recovery snapshot of the current table, whose state payload
  // intentionally has no playedBy attribution.
  const playKey = cards.map(cardIdentity).sort().join("|");

  if (history.recordedPlayKeys.has(playKey)) return null;

  history.recordedPlayKeys.add(playKey);

  const groupSequence = history.nextGroupSequence;
  history.nextGroupSequence += 1;

  const group = cards.map((card, index) => ({
    ...card,
    id: `visual-play-${groupSequence}-${cardIdentity(card)}-${index}`,
  }));

  history.groups = [...history.groups, group];

  return {
    group,
    groupIndex: history.groups.length - 1,
  };
}

export function clearVisualPlayHistory(history) {
  const groups = history?.groups || [];
  const cardCount = groups.reduce((total, group) => total + group.length, 0);

  if (history) {
    history.groups = [];
    history.recordedPlayKeys.clear();
  }

  return { groups, cardCount };
}

export function resetVisualPlayHistory(history) {
  if (!history) return;

  history.groups = [];
  history.recordedPlayKeys.clear();
}
