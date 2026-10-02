export function getSessionRecoveryUiState({
  roomCode,
  sessionReady,
  socketConnected,
}) {
  const hasVisibleRoom = typeof roomCode === "string" && roomCode.length > 0;
  const isReconnecting =
    hasVisibleRoom && (!sessionReady || !socketConnected);

  return {
    isReconnecting,
    interactionsEnabled: sessionReady && !isReconnecting,
  };
}
