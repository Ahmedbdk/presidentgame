export const PLAYER_SESSION_STORAGE_KEY = "presidentgame.player-session.v1";

const ROOM_CODE_PATTERN = /^[A-Z0-9]{4}$/;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isValidStoredPlayerSession(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    typeof value.roomCode === "string" &&
    ROOM_CODE_PATTERN.test(value.roomCode) &&
    typeof value.sessionToken === "string" &&
    SESSION_TOKEN_PATTERN.test(value.sessionToken)
  );
}

export function loadPlayerSession(storage) {
  if (!storage) return null;

  try {
    const parsed = JSON.parse(storage.getItem(PLAYER_SESSION_STORAGE_KEY));

    if (isValidStoredPlayerSession(parsed)) return parsed;
  } catch {
    // Corrupt/blocked storage is equivalent to having no recoverable seat.
  }

  try {
    storage.removeItem(PLAYER_SESSION_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in privacy-restricted contexts.
  }

  return null;
}

export function savePlayerSession(storage, session) {
  if (!storage || !isValidStoredPlayerSession(session)) return false;

  try {
    storage.setItem(PLAYER_SESSION_STORAGE_KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

export function clearPlayerSession(storage) {
  if (!storage) return;

  try {
    storage.removeItem(PLAYER_SESSION_STORAGE_KEY);
  } catch {
    // The in-memory client reset is still safe when storage is unavailable.
  }
}
