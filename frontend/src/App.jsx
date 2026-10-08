import { useState, useEffect, useRef, useMemo, useLayoutEffect } from "react";
import { io } from "socket.io-client";
import {
  advanceTableActionRevision,
  isCurrentTableActionRevision,
} from "./tableActionRevision";
import {
  canSubmitSelectedPlay,
  canUsePlayControls,
} from "./playControlState";
import {
  clearPlayerSession,
  loadPlayerSession,
  savePlayerSession,
} from "./playerSession";
import { getSessionRecoveryUiState } from "./sessionRecoveryUi";
import { SOCKET_URL } from "./socketConfig";
import { DEBUG_TOOLS_ENABLED } from "./debugConfig";
import {
  clearVisualPlayHistory,
  createVisualPlayHistory,
  recordVisualPlay,
  resetVisualPlayHistory,
} from "./visualPlayHistory";
import {
  getResponsiveHandLayout,
  HAND_CARD_HEIGHT,
  HAND_CARD_WIDTH,
} from "./responsiveHandLayout";
import { reconcileHandOrder } from "./handOrder";
import { AVATAR_OPTIONS, AvatarPicker, PlayerAvatar } from "./Avatars";

const socket = SOCKET_URL ? io(SOCKET_URL) : io();

const RANKS = [
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

// Client-side only concept used for the President/Vice President card
// request selection window - not a real card in the deck. Requesting
// it simply flows through the exact same requestCard/exchange socket
// events as any other rank; the server just won't find a match for it
// in anyone's hand (handled by existing "responderHasCard" logic).
const JOKER_RANK = "JOKER";
const REQUEST_RANKS = [...RANKS, JOKER_RANK];

const DEBUG_RANK_BUTTONS = [
  { rank: "President", icon: "👑", label: "Become President" },
  { rank: "Vice President", icon: "🥈", label: "Become Vice President" },
  { rank: "Asshole", icon: "💀", label: "Become Asshole" },
  { rank: "Vice Asshole", icon: "🥉", label: "Become Vice Asshole" },
];

const RANK_VALUES = {
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

const SUIT_ORDER = { "♠": 0, "♥": 1, "♦": 2, "♣": 3 };

// Display order + icon for the results screen. "Nothing" covers
// anyone who finished without landing a special role.
const ROLE_DISPLAY = [
  { rank: "President", icon: "👑" },
  { rank: "Vice President", icon: "🥈" },
  { rank: "Nothing", icon: "🙂" },
  { rank: "Vice Asshole", icon: "🥉" },
  { rank: "Asshole", icon: "💀" },
];

const ROLE_ICON = ROLE_DISPLAY.reduce((acc, r) => {
  acc[r.rank] = r.icon;
  return acc;
}, {});

function ordinal(position) {
  const value = Number(position);
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  if (value % 10 === 1) return `${value}st`;
  if (value % 10 === 2) return `${value}nd`;
  if (value % 10 === 3) return `${value}rd`;
  return `${value}th`;
}

function sortHand(cards, direction) {
  const sorted = [...cards].sort((a, b) => {
    const diff = RANK_VALUES[a.rank] - RANK_VALUES[b.rank];
    if (diff !== 0) return diff;
    return SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
  });

  if (direction === "desc") {
    sorted.reverse();
  }

  return sorted;
}

const DEFAULT_AVATAR = AVATAR_OPTIONS[0];

const RED_SUITS = ["♥", "♦"];

// Table cards (the "current play" pile) intentionally reuse the same
// dimensions as hand cards - same component, same readability - so
// spacing between stacked cards/groups scales off the same numbers
// instead of a separate hand-tuned pixel value.
const TABLE_CARD_SPREAD = Math.round(HAND_CARD_WIDTH * 0.38);

// Deterministic "how does this group sit on the pile" placement,
// shared by the static CenterPile render and the in-flight throw
// animation so a card lands already rotated/offset to match exactly
// where the static card will render on the very next frame.
function groupPlacement(globalGroupIdx) {
  const baseSeed = (globalGroupIdx + 1) * 23;
  return {
    rot: (baseSeed % 16) - 8,
    y: (baseSeed % 8) - 4,
  };
}

function cardRotationInGroup(cardIdx, count) {
  return (cardIdx - (count - 1) / 2) * 5;
}

function cardOffsetInGroup(cardIdx, count) {
  return (cardIdx - (count - 1) / 2) * TABLE_CARD_SPREAD;
}

// Distributes every seated (non-spectator) player evenly around the
// full table, in screen-angle degrees where 0=right, 90=bottom,
// 180=left, 270=top. Index 0 is always the local player and always
// lands at the bottom (90deg) - callers are responsible for ordering
// the players array so index 0 is "me". This single formula is what
// gives 2 players opposite sides, 4 players top/bottom/left/right,
// 5-6+ evenly spaced, etc., without special-casing player counts.
function seatAngles(n) {
  if (n <= 0) return [];
  if (n === 1) return [90];
  return Array.from({ length: n }, (_, i) => (90 + (360 * i) / n) % 360);
}

// Ellipse around the table's visual center. Radii are tuned so every
// seat's avatar/name pill (and, for opponents, their card-back fan)
// stays inside the table-oval bounds and clear of the center pile.
function seatPosition(angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const left = 50 + 42 * Math.cos(rad);
  const top = 50 + 40 * Math.sin(rad);
  return { left: `${left}%`, top: `${top}%` };
}

// The more players sharing the same ellipse, the closer together
// each seat sits - shrink the seat pill/fan a little as the count
// grows so neighboring seats never crowd or overlap each other,
// instead of ever touching a fixed pixel size regardless of count.
function seatScale(n) {
  if (n <= 4) return 1;
  if (n <= 6) return 0.9;
  if (n <= 8) return 0.8;
  return 0.7;
}

// Which way an opponent's card-back fan should point so it reads
// naturally from that seat's position around the table, based on
// which side of the table the seat sits on (left/right/top-ish).
function seatFacing(angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  if (c < -0.35) return "left";
  if (c > 0.35) return "right";
  return "top";
}

function fanTransform(angle, facing, extra = 0) {
  const rot =
    facing === "left" ? angle - 90 : facing === "right" ? angle + 90 : angle;
  return `rotate(${rot}deg) translateY(${extra}px)`;
}

function CardBackFan({ count, facing, fanRef }) {
  const n = Math.min(count, 13);
  const spread = Math.min(78, 10 + n * 7);

  return (
    <div className={`fan-wrap fan-${facing}`} ref={fanRef}>
      {Array.from({ length: n }, (_, i) => {
        const angle = n <= 1 ? 0 : -spread / 2 + (spread * i) / (n - 1);

        return (
          <div
            key={i}
            className="fan-card-back"
            style={{ transform: fanTransform(angle, facing), zIndex: i }}
          />
        );
      })}
    </div>
  );
}

function PlayerSeat({ player, angle, isTurn, isMe, seatRef, fanRef }) {
  const facing = seatFacing(angle);

  return (
    <div
      className={`seat seat-${isMe ? "me" : facing} ${isTurn ? "seat-active" : ""}`}
      style={seatPosition(angle)}
      ref={seatRef}
    >
      {/* My own cards render as the big fan below the table, not a
          mini card-back fan at my seat - showing both would just be
          the same hand drawn twice. */}
      {!player.spectator && !isMe && (
        <CardBackFan count={player.cardCount} facing={facing} fanRef={fanRef} />
      )}

      <div className={`seat-pill ${isTurn ? "active" : ""} ${isMe ? "seat-pill-me" : ""}`}>
        <span className="avatar-circle has-avatar">
          <PlayerAvatar player={player} />
        </span>
        <span className="seat-name">
          {player.username}
          {player.host && " 👑"}
          {isMe && " (You)"}
        </span>
        <span className="seat-count">
          {player.spectator
            ? "Spectating"
            : player.finished
              ? `${player.rank || "Nothing"} — ${ordinal(player.finishPosition)}`
              : `${player.cardCount} card${player.cardCount === 1 ? "" : "s"}`}
        </span>
      </div>
    </div>
  );
}

function ExitIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      width="17"
      height="17"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M15 17L20 12M20 12L15 7M20 12H9M9 21H6C4.89543 21 4 20.1046 4 19V5C4 3.89543 4.89543 3 6 3H9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      className="room-badge-copy-icon"
      viewBox="0 0 24 24"
      fill="none"
      width="14"
      height="14"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
      <path
        d="M5 15H4C3.44772 15 3 14.5523 3 14V4C3 3.44772 3.44772 3 4 3H14C14.5523 3 15 3.44772 15 4V5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CardFace({ card }) {
  const isRed = RED_SUITS.includes(card.suit);
  const colorClass = isRed ? "cf-red" : "cf-black";

  return (
    <>
      <span className={`cf-corner cf-top ${colorClass}`}>
        <span className="cf-rank">{card.rank}</span>
        <span className="cf-suit">{card.suit}</span>
      </span>
      <span className={`cf-center ${colorClass}`}>{card.suit}</span>
      <span className={`cf-corner cf-bottom ${colorClass}`}>
        <span className="cf-rank">{card.rank}</span>
        <span className="cf-suit">{card.suit}</span>
      </span>
    </>
  );
}

function computePlayableRanks(hand, table) {
  const playable = new Set();

  if (!hand || hand.length === 0) return playable;

  const counts = {};
  hand.forEach((card) => {
    counts[card.rank] = (counts[card.rank] || 0) + 1;
  });

  if (!table || table.length === 0) {
    Object.keys(counts).forEach((rank) => playable.add(rank));
    return playable;
  }

  const tableIsBomb =
    table.length === 4 && new Set(table.map((c) => c.rank)).size === 1;

  const tableValue = tableIsBomb
    ? 100 + RANK_VALUES[table[0].rank]
    : RANK_VALUES[table[0].rank];

  Object.entries(counts).forEach(([rank, count]) => {
    const rankValue = RANK_VALUES[rank];

    if (count === 4 && 100 + rankValue > tableValue) {
      playable.add(rank);
    }

    if (!tableIsBomb && count >= table.length && rankValue > tableValue) {
      playable.add(rank);
    }
  });

  return playable;
}

function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => setWidth(el.getBoundingClientRect().width);
    update();

    const observer = new ResizeObserver(update);
    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

function CenterPile({ playedGroups, pileRef }) {
  if (!playedGroups || playedGroups.length === 0) {
    return (
      <div className="center-pile empty" ref={pileRef}>
        <span className="pile-dot" />
        Table is open
      </div>
    );
  }

  const visibleGroups = playedGroups.slice(-5);
  const latestGroup = playedGroups[playedGroups.length - 1] || [];

  return (
    <div className="center-pile-container">
      <div className="center-pile" ref={pileRef}>
        {visibleGroups.map((group, groupIdx) => {
          const globalGroupIdx = playedGroups.length - visibleGroups.length + groupIdx;
          const isLatest = groupIdx === visibleGroups.length - 1;

          const { rot: groupBaseRot, y: groupBaseY } = groupPlacement(globalGroupIdx);

          const count = group.length;

          return (
            <div
              key={`group-${globalGroupIdx}`}
              className="table-play-group"
              style={{
                zIndex: globalGroupIdx * 10,
                transform: `translate(-50%, calc(-50% + ${groupBaseY}px)) rotate(${groupBaseRot}deg)`,
                opacity: isLatest ? 1 : 0.65,
              }}
            >
              {group.map((card, cardIdx) => {
                const cardOffsetX = cardOffsetInGroup(cardIdx, count);
                const cardRot = cardRotationInGroup(cardIdx, count);

                return (
                  <div
                    key={card.id || `${card.rank}-${card.suit}-${cardIdx}`}
                    className={`table-card stacked-card ${isLatest ? 'latest-play' : ''}`}
                    style={{
                      transform: `translate(${cardOffsetX}px, 0) rotate(${cardRot}deg)`,
                      zIndex: cardIdx + 1,
                    }}
                  >
                    <CardFace card={card} />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="pile-count-badge">
        Current Play: {latestGroup.length} {latestGroup.length === 1 ? "card" : "cards"}
      </div>
    </div>
  );
}

function DiscardPile({ count, discardRef }) {
  const visible = Math.min(count, 12);

  return (
    <div className="discard-pile-container" ref={discardRef}>
      <div className="discard-pile">
        {count === 0 ? (
          <div className="discard-placeholder">Discard</div>
        ) : (
          Array.from({ length: visible }, (_, i) => {
            const rot = ((i * 13) % 18) - 9;
            const offsetX = ((i * 7) % 6) - 3;
            const offsetY = ((i * 11) % 6) - 3;

            return (
              <div
                key={i}
                className="discard-card-back"
                style={{
                  transform: `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px)) rotate(${rot}deg)`,
                  zIndex: i + 1,
                }}
              />
            );
          })
        )}
      </div>
      <div className="discard-count-badge">
        History ({count})
      </div>
    </div>
  );
}

// A single selectable "card" in the President/Vice President rank
// request grid. Styled to match the look of a real playing card
// (cream face, corner pips) since suit doesn't matter for a request -
// except for the Joker option, which gets its own distinct treatment.
function RequestCardTile({ rank, onClick, big, disabled = false }) {
  const isJoker = rank === JOKER_RANK;

  return (
    <button
      type="button"
      className={`request-card ${isJoker ? "request-card-joker" : ""} ${
        big ? "request-card-big" : ""
      }`}
      onClick={onClick}
      disabled={disabled}
    >
      {isJoker ? (
        <>
          <span className="request-card-joker-icon">🃏</span>
          <span className="request-card-joker-label">Joker</span>
        </>
      ) : (
        <>
          <span className="request-card-corner request-card-corner-top">
            {rank}
          </span>
          <span className="request-card-suits">♠ ♥ ♦ ♣</span>
          <span className="request-card-corner request-card-corner-bottom">
            {rank}
          </span>
        </>
      )}
    </button>
  );
}

function App() {
  const [username, setUsername] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [selectedAvatar, setSelectedAvatar] = useState(DEFAULT_AVATAR);

  const [myRoom, setMyRoom] = useState("");
  const [players, setPlayers] = useState([]);
  const [roomPhase, setRoomPhase] = useState(null);
  const [sessionReady, setSessionReady] = useState(() => {
    if (typeof window === "undefined") return true;
    return !loadPlayerSession(window.localStorage);
  });
  const {
    isReconnecting,
    interactionsEnabled: sessionInteractionsEnabled,
  } = getSessionRecoveryUiState({
    roomCode: myRoom,
    sessionReady,
    socketConnected: socket.connected,
  });

  const [gameStarted, setGameStarted] = useState(false);
  const [isHost, setIsHost] = useState(false);

  const [hand, setHand] = useState([]);
  const [selectedCards, setSelectedCards] = useState([]);

  const [sortDirection, setSortDirection] = useState("asc");
  const sortDirectionRef = useRef("asc");
  const manualHandOrderRef = useRef(false);

  const [draggedIndex, setDraggedIndex] = useState(null);

  const [tableCards, setTableCards] = useState([]);
  const [playedGroups, setPlayedGroups] = useState([]);
  const [discardedCardsCount, setDiscardedCardsCount] = useState(0);

  const [myTurn, setMyTurn] = useState(false);
  const [turnPlayerId, setTurnPlayerId] = useState(null);

  const [finalRankings, setFinalRankings] = useState(null);
  const [finishAnnouncement, setFinishAnnouncement] = useState(null);

  const [readyClicked, setReadyClicked] = useState(false);
  const [readyCount, setReadyCount] = useState(0);
  const [readyTotal, setReadyTotal] = useState(0);

  const [exchangeInfo, setExchangeInfo] = useState(null);
  const [cardRequestPrompt, setCardRequestPrompt] = useState(null);
  const [cardOffer, setCardOffer] = useState(null);
  const [returnPrompt, setReturnPrompt] = useState(null);

  // Holds the rank/card the player has tapped but not yet confirmed.
  // Nothing is sent to the server until the "Yes" button on the
  // confirmation prompt is clicked - these are purely local UI state.
  const [pendingRankSelection, setPendingRankSelection] = useState(null);
  const [pendingReturnCard, setPendingReturnCard] = useState(null);

  // Leave Room now asks for confirmation instead of leaving instantly -
  // this just gates the existing leaveRoom() socket/state logic behind
  // a "Yes, I'm sure" tap, same pattern as the exchange confirmations.
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  const [handWrapRef, handWrapWidth] = useElementWidth();

  const [flyingCards, setFlyingCards] = useState([]);
  const [clearingCards, setClearingCards] = useState([]);
  // Card keys (rank-suit) currently mid-flight from hand to table -
  // the matching card in the hand fan is hidden (not removed) while
  // its key is in here, so the thrown clone is the only copy visible
  // instead of showing the same card twice during the animation.
  const [flyingSourceKeys, setFlyingSourceKeys] = useState(() => new Set());
  const [roomCodeCopied, setRoomCodeCopied] = useState(false);
  // Debug Tools panel is collapsed by default - only shown once the
  // player explicitly taps the small toggle, and stays out of the
  // way of normal gameplay otherwise.
  const [showDebugTools, setShowDebugTools] = useState(false);
  const copyTimeoutRef = useRef(null);
  const finishAnnouncementTimeoutRef = useRef(null);
  const finishAnnouncementQueueRef = useRef([]);
  // Invalidates any card-animation callbacks that were scheduled before the
  // server moved this room back to WAITING (or closed it entirely).
  const roomUiEpochRef = useRef(0);
  const animationHandlersRef = useRef({ play: null, clear: null });
  // Every authoritative table/lifecycle action advances this revision. Card
  // animation callbacks are presentation-only and may commit only while the
  // revision they captured is still current.
  const tableActionRevisionRef = useRef(0);
  const cardRefs = useRef({});
  const seatRefs = useRef({});
  const fanRefs = useRef({});
  const pileRef = useRef(null);
  const discardRef = useRef(null);

  // This per-pile ledger is updated synchronously from authoritative play
  // events. The rendered pile and flying-card layers may lag behind it, but
  // interrupted animation callbacks can no longer erase confirmed history.
  const visualPlayHistoryRef = useRef(createVisualPlayHistory());

  function invalidatePendingTableAnimations({
    clearPile = false,
    settleHistory = false,
  } = {}) {
    const revision = advanceTableActionRevision(tableActionRevisionRef);

    setFlyingCards([]);
    setClearingCards([]);
    setFlyingSourceKeys(new Set());

    if (clearPile) {
      resetVisualPlayHistory(visualPlayHistoryRef.current);
      setPlayedGroups([]);
    } else if (settleHistory) {
      setPlayedGroups([...visualPlayHistoryRef.current.groups]);
    }

    return revision;
  }

  // Lets the yourCards handler below (registered once in the effect
  // that follows) know whether we're still on the post-round screens
  // (results / exchange) when a fresh hand comes in, without needing
  // yourCards itself in the effect's dependency array.
  const finalRankingsRef = useRef(finalRankings);
  useEffect(() => {
    finalRankingsRef.current = finalRankings;
  }, [finalRankings]);

  useEffect(() => {
    const resetAfterFailedRecovery = () => {
      manualHandOrderRef.current = false;
      roomUiEpochRef.current += 1;
      invalidatePendingTableAnimations({ clearPile: true });
      setMyRoom("");
      setPlayers([]);
      setRoomPhase(null);
      setGameStarted(false);
      setIsHost(false);
      setHand([]);
      setSelectedCards([]);
      setDraggedIndex(null);
      setTableCards([]);
      setPlayedGroups([]);
      setDiscardedCardsCount(0);
      setMyTurn(false);
      setTurnPlayerId(null);
      setFinalRankings(null);
      setFinishAnnouncement(null);
      finishAnnouncementQueueRef.current = [];
      if (finishAnnouncementTimeoutRef.current) {
        clearTimeout(finishAnnouncementTimeoutRef.current);
        finishAnnouncementTimeoutRef.current = null;
      }
      setReadyClicked(false);
      setReadyCount(0);
      setReadyTotal(0);
      setExchangeInfo(null);
      setCardRequestPrompt(null);
      setCardOffer(null);
      setReturnPrompt(null);
      setPendingRankSelection(null);
      setPendingReturnCard(null);
      setShowLeaveConfirm(false);
      setRoomCodeCopied(false);
    };

    const recoverStoredSession = () => {
      const storedSession = loadPlayerSession(window.localStorage);

      if (!storedSession) {
        setSessionReady(true);
        return;
      }

      setSessionReady(false);
      socket.emit("recoverSession", storedSession, (result) => {
        if (result?.ok) return;

        clearPlayerSession(window.localStorage);
        resetAfterFailedRecovery();
        setSessionReady(true);
      });
    };

    socket.on("connect", recoverStoredSession);

    socket.on("disconnect", () => {
      if (loadPlayerSession(window.localStorage)) {
        setSessionReady(false);
        setSelectedCards([]);
      }
    });

    socket.on("sessionAssigned", (data) => {
      savePlayerSession(window.localStorage, data);
      setSessionReady(true);
    });

    socket.on("sessionRecovered", (data) => {
      setReadyClicked(!!data.ready);
      setSessionReady(true);
    });

    socket.on("sessionRecoveryFailed", () => {
      clearPlayerSession(window.localStorage);
      resetAfterFailedRecovery();
      setSessionReady(true);
    });

    socket.on("sessionReplaced", () => {
      // Do not clear localStorage: browser tabs share it, and the newer tab
      // now legitimately owns this token. This tab is explicitly detached.
      resetAfterFailedRecovery();
      setSessionReady(false);
    });

    if (socket.connected) recoverStoredSession();

    socket.on("roomCreated", (data) => {
      setMyRoom(data.roomCode);
      setPlayers(data.players);
      setRoomPhase(data.phase || "WAITING");
      setIsHost(true);
    });

    socket.on("updateRoom", (data) => {
      setMyRoom(data.roomCode);
      setPlayers(data.players);
      setRoomPhase(data.phase || null);

      if (data.phase === "WAITING" || data.phase === "RESULTS") {
        manualHandOrderRef.current = false;
      }

      if (data.phase !== "PLAYING") {
        setSelectedCards([]);
      }

      // The server uses an empty room code when it terminates a room.
      // Clear every room-scoped value just as thoroughly as an explicit
      // Leave action so stale round state cannot leak into the next room.
      if (!data.roomCode) {
        manualHandOrderRef.current = false;
        clearPlayerSession(window.localStorage);
        setSessionReady(true);
        roomUiEpochRef.current += 1;
        invalidatePendingTableAnimations({ clearPile: true });
        setGameStarted(false);
        setIsHost(false);
        setHand([]);
        setSelectedCards([]);
        setDraggedIndex(null);
        setTableCards([]);
        setPlayedGroups([]);
        setDiscardedCardsCount(0);
        setClearingCards([]);
        setMyTurn(false);
        setTurnPlayerId(null);
        setFinalRankings(null);
        setFinishAnnouncement(null);
        finishAnnouncementQueueRef.current = [];
        if (finishAnnouncementTimeoutRef.current) {
          clearTimeout(finishAnnouncementTimeoutRef.current);
          finishAnnouncementTimeoutRef.current = null;
        }
        setReadyClicked(false);
        setReadyCount(0);
        setReadyTotal(0);
        setExchangeInfo(null);
        setCardRequestPrompt(null);
        setCardOffer(null);
        setReturnPrompt(null);
        setPendingRankSelection(null);
        setPendingReturnCard(null);
        setShowLeaveConfirm(false);
        setFlyingCards([]);
        setFlyingSourceKeys(new Set());
        setRoomCodeCopied(false);
        if (copyTimeoutRef.current) {
          clearTimeout(copyTimeoutRef.current);
          copyTimeoutRef.current = null;
        }
        return;
      }

      // A room with fewer than two active players can be authoritatively
      // recovered to WAITING without changing its room code. Project that
      // phase explicitly so clients leave gameplay/results/exchange screens
      // and the promoted host can actually see and use Start Game.
      if (data.phase === "WAITING") {
        roomUiEpochRef.current += 1;
        invalidatePendingTableAnimations({ clearPile: true });
        setGameStarted(false);
        setHand([]);
        setSelectedCards([]);
        setDraggedIndex(null);
        setTableCards([]);
        setPlayedGroups([]);
        setDiscardedCardsCount(0);
        setClearingCards([]);
        setMyTurn(false);
        setTurnPlayerId(null);
        setFinalRankings(null);
        setFinishAnnouncement(null);
        finishAnnouncementQueueRef.current = [];
        if (finishAnnouncementTimeoutRef.current) {
          clearTimeout(finishAnnouncementTimeoutRef.current);
          finishAnnouncementTimeoutRef.current = null;
        }
        setReadyClicked(false);
        setReadyCount(0);
        setReadyTotal(0);
        setExchangeInfo(null);
        setCardRequestPrompt(null);
        setCardOffer(null);
        setReturnPrompt(null);
        setPendingRankSelection(null);
        setPendingReturnCard(null);
        setShowLeaveConfirm(false);
        setFlyingCards([]);
        setFlyingSourceKeys(new Set());
      }

      const me = data.players.find((p) => p.id === socket.id);
      if (me) {
        setIsHost(me.host);

        if (me.spectator || me.finished) {
          setSelectedCards([]);
        }
      }
    });

    socket.on("yourCards", (cards) => {
      if (manualHandOrderRef.current) {
        setHand((previousHand) => reconcileHandOrder(previousHand, cards));
      } else {
        setHand(sortHand(cards, sortDirectionRef.current));
      }
      setSelectedCards([]);

      // A fresh hand arriving while we're still on the results/exchange
      // screens means a new round just started dealing - clear last
      // round's leftover table/discard visuals so the table shown
      // behind the exchange modal isn't stale.
      if (finalRankingsRef.current) {
        invalidatePendingTableAnimations({ clearPile: true });
        setDiscardedCardsCount(0);
        setTableCards([]);
      }
    });

    socket.on("errorMessage", (msg) => {
      alert(msg);
    });

    socket.on("gameStarted", () => {
      roomUiEpochRef.current += 1;
      invalidatePendingTableAnimations({ clearPile: true });
      setGameStarted(true);
      setSelectedCards([]);
      setTableCards([]);
      setDiscardedCardsCount(0);
      setFinalRankings(null);
      setFinishAnnouncement(null);
      finishAnnouncementQueueRef.current = [];
      if (finishAnnouncementTimeoutRef.current) {
        clearTimeout(finishAnnouncementTimeoutRef.current);
        finishAnnouncementTimeoutRef.current = null;
      }
      setReadyClicked(false);
      setReadyCount(0);
      setReadyTotal(0);
      setExchangeInfo(null);
      setCardRequestPrompt(null);
      setCardOffer(null);
      setReturnPrompt(null);
      setPendingRankSelection(null);
      setPendingReturnCard(null);
    });

    socket.on("turnUpdate", (data) => {
      setTurnPlayerId(data.playerId);
      setMyTurn(data.playerId === socket.id);

      if (data.playerId !== socket.id) {
        setSelectedCards([]);
      }
    });

    socket.on("tableUpdate", (data) => {
      const newPlayedCards = Array.isArray(data.table) ? data.table : [];
      const tableRevision = invalidatePendingTableAnimations({
        settleHistory: true,
      });

      // These are authoritative game-state projections and must never wait
      // for presentation timing. Animations below only update visual layers.
      setTableCards(newPlayedCards);
      setSelectedCards([]);
      setTurnPlayerId(data.nextPlayer);
      setMyTurn(data.nextPlayer === socket.id);

      if (newPlayedCards.length > 0) {
        const recordedPlay = recordVisualPlay(
          visualPlayHistoryRef.current,
          newPlayedCards
        );

        if (recordedPlay) {
          animationHandlersRef.current.play?.(
            data.playedBy,
            recordedPlay.group,
            recordedPlay.groupIndex,
            tableRevision
          );
        }
      } else {
        const { groups, cardCount } = clearVisualPlayHistory(
          visualPlayHistoryRef.current
        );

        setPlayedGroups([]);

        if (cardCount > 0) {
          setDiscardedCardsCount((previous) => previous + cardCount);
        }

        if (groups.length > 0) {
          animationHandlersRef.current.clear?.(
            groups,
            tableRevision
          );
        }
      }
    });

    socket.on("gameFinished", (data) => {
      invalidatePendingTableAnimations({ clearPile: true });
      setTableCards([]);
      setSelectedCards([]);
      setTurnPlayerId(null);
      setFinalRankings(data.rankings);
      setMyTurn(false);
    });

    const showFinishAnnouncement = (data) => {
      setFinishAnnouncement(data);
      finishAnnouncementTimeoutRef.current = setTimeout(() => {
        finishAnnouncementTimeoutRef.current = null;
        const next = finishAnnouncementQueueRef.current.shift();
        if (next) {
          showFinishAnnouncement(next);
        } else {
          setFinishAnnouncement(null);
        }
      }, data.rank === "President" ? 3800 : 2800);
    };

    socket.on("playerFinished", (data) => {
      if (finishAnnouncementTimeoutRef.current) {
        finishAnnouncementQueueRef.current.push(data);
      } else {
        showFinishAnnouncement(data);
      }
    });

    socket.on("readyUpdate", (data) => {
      setReadyCount(data.count);
      setReadyTotal(data.total);
    });

    socket.on("exchangeInProgress", (data) => {
      invalidatePendingTableAnimations({ clearPile: true });
      setTableCards([]);
      setSelectedCards([]);
      setTurnPlayerId(null);
      setMyTurn(false);
      setExchangeInfo(data);
    });

    socket.on("chooseCardRequest", (data) => {
      setCardRequestPrompt(data);
      setPendingRankSelection(null);
    });

    socket.on("cardRequested", (data) => {
      setCardOffer(data);
    });

    socket.on("chooseCardToReturn", (data) => {
      setReturnPrompt(data);
      setPendingReturnCard(null);
    });

    socket.on("exchangeStageCancelled", () => {
      setCardRequestPrompt(null);
      setCardOffer(null);
      setReturnPrompt(null);
      setPendingRankSelection(null);
      setPendingReturnCard(null);
    });

    

    return () => {
      roomUiEpochRef.current += 1;
      advanceTableActionRevision(tableActionRevisionRef);
      if (finishAnnouncementTimeoutRef.current) {
        clearTimeout(finishAnnouncementTimeoutRef.current);
      }
      socket.off();
    };
  }, []);

  function triggerPlayAnimation(
    playedBy,
    animatedGroup,
    globalGroupIdx,
    tableRevision
  ) {
    const roomUiEpoch = roomUiEpochRef.current;

    if (!pileRef.current) {
      if (
        roomUiEpochRef.current !== roomUiEpoch ||
        !isCurrentTableActionRevision(tableActionRevisionRef, tableRevision)
      ) {
        return;
      }

      setPlayedGroups([...visualPlayHistoryRef.current.groups]);
      return;
    }

    const pileRect = pileRef.current.getBoundingClientRect();
    const targetCenterX = pileRect.left + pileRect.width / 2;
    const targetCenterY = pileRect.top + pileRect.height / 2;

    let fallbackStartX = targetCenterX;
    let fallbackStartY = targetCenterY + 200;

    const isMe = playedBy === socket.id;

    // For opponents, prefer the actual rendered card-back fan (their
    // real on-screen "hand") over the seat pill - this is what makes
    // the flying card originate from exactly where their cards are
    // displayed, and lets us read its real on-screen size so the
    // card can visibly grow from hand-size to table-size as it
    // travels, rather than popping to full size mid-flight.
    let opponentOriginRect = null;

    if (!isMe) {
      if (fanRefs.current[playedBy]) {
        opponentOriginRect = fanRefs.current[playedBy].getBoundingClientRect();
      } else if (seatRefs.current[playedBy]) {
        opponentOriginRect = seatRefs.current[playedBy].getBoundingClientRect();
      }

      if (opponentOriginRect) {
        fallbackStartX = opponentOriginRect.left + opponentOriginRect.width / 2;
        fallbackStartY = opponentOriginRect.top + opponentOriginRect.height / 2;
      }
    }

    // Scale the flying card starts at, so it visually matches the
    // size of the cards actually shown in that opponent's fan (a
    // small card-back), then grows to scale(1) - the full table-card
    // size - by the time it lands. Own plays keep their existing
    // subtle "pop" behavior (handled separately below), since that
    // animation already reads real per-card size/position off the
    // hand fan.
    let opponentStartScale = 0.42;

    if (opponentOriginRect && opponentOriginRect.width > 0) {
      const ratio = opponentOriginRect.width / HAND_CARD_WIDTH;
      // Clamp to a sane visible range - a raw ratio can be tiny at
      // some responsive breakpoints, which would make the origin
      // point read as an invisible speck rather than a small card.
      opponentStartScale = Math.min(0.6, Math.max(0.25, ratio));
    }

    // The group index was reserved when authoritative history was recorded,
    // so the flying card can animate directly to the
    // rotation/offset the static pile card will render with the instant
    // it lands, instead of flying to one spot and then visibly snapping.
    const { rot: groupBaseRot, y: groupBaseY } = groupPlacement(globalGroupIdx);
    const count = animatedGroup.length;

    const newFlyingCards = animatedGroup.map((card, idx) => {
      const cardKey = `${card.rank}-${card.suit}`;

      // For my own plays, each card flies from its OWN real position and
      // real on-hand rotation (read straight off the fan card's inline
      // --rot custom property) - not an approximated single start point -
      // so a multi-card play throws from exactly where each card sat.
      let startX = fallbackStartX;
      let startY = fallbackStartY;
      let startRot = 0;
      let startScale = 0.92;

      if (isMe && cardRefs.current[cardKey]) {
        const el = cardRefs.current[cardKey];
        const rect = el.getBoundingClientRect();
        startX = rect.left + rect.width / 2;
        startY = rect.top + rect.height / 2;
        startRot = parseFloat(el.style.getPropertyValue("--rot")) || 0;
        startScale = 0.92;
      } else if (!isMe) {
        // Opponent hands only ever show card backs, so there's no real
        // per-card rotation to read - fan the thrown cards out slightly
        // instead so a multi-card play still reads as a natural toss,
        // spread around the real fan position/size we measured above.
        const spreadScale = Math.max(opponentStartScale, 0.3);
        startRot = (idx - (count - 1) / 2) * 10;
        startX = fallbackStartX + (idx - (count - 1) / 2) * 16 * spreadScale;
        startY = fallbackStartY;
        startScale = opponentStartScale;
      }

      const targetOffsetX = cardOffsetInGroup(idx, count);
      const targetRot = groupBaseRot + cardRotationInGroup(idx, count);

      return {
        id: card.id,
        cardKey,
        card,
        startX,
        startY,
        startRot,
        startScale,
        targetX: targetCenterX + targetOffsetX,
        targetY: targetCenterY + groupBaseY,
        targetRot,
        active: false,
      };
    });

    const batchIds = new Set(newFlyingCards.map((fc) => fc.id));

    // The current throw owns the animation layer. If a newer authoritative
    // action interrupts it, invalidation removes this flight while the
    // already-recorded group is settled into the static pile independently.
    setFlyingCards((prev) => [...prev, ...newFlyingCards]);

    if (isMe) {
      setFlyingSourceKeys((prev) => {
        const next = new Set(prev);
        newFlyingCards.forEach((fc) => next.add(fc.cardKey));
        return next;
      });
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (
          roomUiEpochRef.current !== roomUiEpoch ||
          !isCurrentTableActionRevision(tableActionRevisionRef, tableRevision)
        ) {
          return;
        }

        setFlyingCards((prev) =>
          prev.map((fc) => (batchIds.has(fc.id) ? { ...fc, active: true } : fc))
        );
      });
    });

    setTimeout(() => {
      if (
        roomUiEpochRef.current !== roomUiEpoch ||
        !isCurrentTableActionRevision(tableActionRevisionRef, tableRevision)
      ) {
        return;
      }

      setFlyingCards((prev) => prev.filter((fc) => !batchIds.has(fc.id)));
      setPlayedGroups([...visualPlayHistoryRef.current.groups]);

      if (isMe) {
        setFlyingSourceKeys((prev) => {
          const next = new Set(prev);
          newFlyingCards.forEach((fc) => next.delete(fc.cardKey));
          return next;
        });
      }
    }, 580);
  }

  function triggerClearAnimation(groupsToClear, tableRevision) {
    const roomUiEpoch = roomUiEpochRef.current;

    if (!pileRef.current || !discardRef.current) {
      if (
        roomUiEpochRef.current !== roomUiEpoch ||
        !isCurrentTableActionRevision(tableActionRevisionRef, tableRevision)
      ) {
        return;
      }

      setClearingCards([]);
      return;
    }

    const pileRect = pileRef.current.getBoundingClientRect();
    const discardRect = discardRef.current.getBoundingClientRect();

    const startX = pileRect.left + pileRect.width / 2;
    const startY = pileRect.top + pileRect.height / 2;

    const targetX = discardRect.left + discardRect.width / 2;
    const targetY = discardRect.top + discardRect.height / 2;

    const allCardsToClear = groupsToClear.flat();
    const visibleToClear = allCardsToClear.slice(-15);

    const animatedClearing = visibleToClear.map((card, idx) => ({
      id: card.id || `${card.rank}-${card.suit}-${idx}`,
      card,
      startX: startX + (idx - (visibleToClear.length - 1) / 2) * 4,
      startY: startY + (idx % 3) * 2,
      targetX: targetX + ((idx % 4) - 2) * 4,
      targetY: targetY + ((idx % 3) - 1) * 4,
      active: false,
    }));

    setClearingCards(animatedClearing);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (
          roomUiEpochRef.current !== roomUiEpoch ||
          !isCurrentTableActionRevision(tableActionRevisionRef, tableRevision)
        ) {
          return;
        }

        setClearingCards((prev) => prev.map((c) => ({ ...c, active: true })));
      });
    });

    setTimeout(() => {
      if (
        roomUiEpochRef.current !== roomUiEpoch ||
        !isCurrentTableActionRevision(tableActionRevisionRef, tableRevision)
      ) {
        return;
      }

      setClearingCards([]);
    }, 650);
  }

  useLayoutEffect(() => {
    animationHandlersRef.current.play = triggerPlayAnimation;
    animationHandlersRef.current.clear = triggerClearAnimation;
  });

  function createRoom() {
    if (!sessionInteractionsEnabled) return;
    if (!username.trim()) {
      alert("Enter a name first");
      return;
    }
    socket.emit("createRoom", { username, avatar: selectedAvatar });
  }

  function joinRoom() {
    if (!sessionInteractionsEnabled) return;
    if (!username.trim()) {
      alert("Enter a name first");
      return;
    }
    socket.emit("joinRoom", {
      roomCode: roomCode.trim().toUpperCase(),
      username,
      avatar: selectedAvatar,
    });
  }

  function startGame() {
    if (!sessionInteractionsEnabled) return;
    socket.emit("startGame", myRoom);
  }

  function selectCard(card) {
    if (!sessionInteractionsEnabled) return;

    const exists = selectedCards.some(
      (c) => c.rank === card.rank && c.suit === card.suit
    );

    if (exists) {
      setSelectedCards(
        selectedCards.filter(
          (c) => !(c.rank === card.rank && c.suit === card.suit)
        )
      );
      return;
    }

    if (!myTurn) return;

    if (
      selectedCards.length === 0 &&
      tableCards.length > 0 &&
      !playableRanks.has(card.rank)
    ) {
      return;
    }

    if (selectedCards.length >= 4) {
      return;
    }

    if (selectedCards.length > 0 && selectedCards[0].rank !== card.rank) {
      return;
    }

    setSelectedCards([...selectedCards, card]);
  }

  function handleDragStart(e, index) {
    if (!sessionInteractionsEnabled) return;
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e, index) {
    if (!sessionInteractionsEnabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (draggedIndex === null || draggedIndex === index) return;

    const newHand = [...hand];
    const [draggedCard] = newHand.splice(draggedIndex, 1);
    newHand.splice(index, 0, draggedCard);
    manualHandOrderRef.current = true;
    setHand(newHand);
    setDraggedIndex(index);
  }

  function handleDragEnd() {
    setDraggedIndex(null);
  }

  function playCards() {
    if (!sessionInteractionsEnabled) return;
    socket.emit("playCards", { roomCode: myRoom, cards: selectedCards });
    setSelectedCards([]);
  }

  function passTurn() {
    if (!sessionInteractionsEnabled) return;
    socket.emit("passTurn", myRoom);
    setSelectedCards([]);
  }

  function playAgain() {
    if (!sessionInteractionsEnabled) return;
    socket.emit("readyToPlayAgain", myRoom);
    setReadyClicked(true);
  }

  // ================= DEBUG ONLY =================
  // Fires the debug-only server event that forces this player into a
  // given end-of-round rank via the real finishedPlayers/startNewRound
  // pipeline - see server.js's "debugBecomeRank" handler.
  function debugBecomeRank(rank) {
    if (!myRoom || !sessionInteractionsEnabled) return;
    socket.emit("debugBecomeRank", { roomCode: myRoom, rank });
  }

  function requestCard(rank) {
    if (!sessionInteractionsEnabled) return;
    socket.emit("requestCardFromAsshole", { roomCode: myRoom, rank });
    setCardRequestPrompt(null);
  }

  function respondToRequest(give) {
    if (!sessionInteractionsEnabled) return;
    socket.emit("assholeRespondToRequest", { roomCode: myRoom, give });
    setCardOffer(null);
  }

  function returnCard(card) {
    if (!sessionInteractionsEnabled) return;
    socket.emit("returnCardToAsshole", { roomCode: myRoom, card });
    setReturnPrompt(null);
  }

  // Confirmation-step helpers. These don't change the exchange logic
  // at all - they just gate the existing requestCard/returnCard calls
  // behind a "Yes, I'm sure" tap instead of firing on the first click.
  function confirmRankSelection() {
    if (!sessionInteractionsEnabled || !pendingRankSelection) return;
    requestCard(pendingRankSelection);
    setPendingRankSelection(null);
  }

  function cancelRankSelection() {
    setPendingRankSelection(null);
  }

  function confirmReturnSelection() {
    if (!sessionInteractionsEnabled || !pendingReturnCard) return;
    returnCard(pendingReturnCard);
    setPendingReturnCard(null);
  }

  function cancelReturnSelection() {
    setPendingReturnCard(null);
  }

  function toggleSort() {
    if (!sessionInteractionsEnabled) return;
    const next = sortDirection === "asc" ? "desc" : "asc";

    sortDirectionRef.current = next;
    manualHandOrderRef.current = false;
    setSortDirection(next);
    setHand((prev) => sortHand(prev, next));
  }

  // Copies the room code and shows a brief "Copied!" toast under the
  // badge. Re-clicking while the toast is still up just restarts the
  // timer instead of stacking multiple toasts.
  function copyRoomCode() {
    if (!myRoom) return;

    const fallbackCopy = () => {
      const textarea = document.createElement("textarea");
      textarea.value = myRoom;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      try {
        document.execCommand("copy");
      } catch {
        // Nothing more we can do - the toast just won't appear.
      }
      document.body.removeChild(textarea);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(myRoom).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }

    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }

    setRoomCodeCopied(true);
    copyTimeoutRef.current = setTimeout(() => {
      setRoomCodeCopied(false);
      copyTimeoutRef.current = null;
    }, 1400);
  }

  function leaveRoom() {
    manualHandOrderRef.current = false;
    roomUiEpochRef.current += 1;
    invalidatePendingTableAnimations({ clearPile: true });
    socket.emit("leaveRoom", myRoom);
    clearPlayerSession(window.localStorage);
    setSessionReady(true);

    setMyRoom("");
    setPlayers([]);
    setRoomPhase(null);
    setGameStarted(false);
    setIsHost(false);
    setHand([]);
    setSelectedCards([]);
    setDraggedIndex(null);
    setTableCards([]);
    setPlayedGroups([]);
    setDiscardedCardsCount(0);
    setClearingCards([]);
    setMyTurn(false);
    setTurnPlayerId(null);
    setFinalRankings(null);
    setFinishAnnouncement(null);
    finishAnnouncementQueueRef.current = [];
    setReadyClicked(false);
    setReadyCount(0);
    setReadyTotal(0);
    setExchangeInfo(null);
    setCardRequestPrompt(null);
    setCardOffer(null);
    setReturnPrompt(null);
    setPendingRankSelection(null);
    setPendingReturnCard(null);
    setShowLeaveConfirm(false);
    setFlyingCards([]);
    setFlyingSourceKeys(new Set());
    setRoomCodeCopied(false);
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
    if (finishAnnouncementTimeoutRef.current) {
      clearTimeout(finishAnnouncementTimeoutRef.current);
      finishAnnouncementTimeoutRef.current = null;
    }
  }

  // Opens the "are you sure?" modal instead of leaving immediately -
  // used by every button that used to call leaveRoom() directly.
  function requestLeaveRoom() {
    setShowLeaveConfirm(true);
  }

  function confirmLeaveRoom() {
    leaveRoom();
  }

  function cancelLeaveRoom() {
    setShowLeaveConfirm(false);
  }

  const me = players.find((p) => p.id === socket.id);
  const isSpectator = !!me?.spectator;

  // Spectators get their own strip below the topbar rather than a
  // ring seat - they aren't part of the active hand of play, so they
  // shouldn't factor into how the table seats are distributed.
  const spectatorPlayers = players.filter((p) => p.spectator);
  const seatedPlayers = players.filter((p) => !p.spectator);

  // Order the seated players so "me" (if I'm seated) is always index
  // 0, which is what makes seatAngles land my seat at the bottom.
  const myIndex = seatedPlayers.findIndex((p) => p.id === socket.id);
  const orderedSeatedPlayers =
    myIndex === -1
      ? seatedPlayers
      : [
          seatedPlayers[myIndex],
          ...seatedPlayers.slice(myIndex + 1),
          ...seatedPlayers.slice(0, myIndex),
        ];
  const tableSeatAngles = seatAngles(orderedSeatedPlayers.length);

  const isLivePlay =
    roomPhase === "PLAYING" && gameStarted && !finalRankings;

  // The exchange phase (auto-swap + card requests) happens after
  // everyone has clicked Play Again but before the next round's table
  // view takes over. While it's running we want the dedicated results
  // screen (with its player list + Play Again/Exit buttons) to step
  // aside in favor of the exchange prompts.
  const exchangeStarted = !!exchangeInfo;

  // True from the moment dealing finishes and an exchange stage kicks
  // off, until the round is finalized (server's "gameStarted" event
  // clears finalRankings). The table itself should be visible for the
  // whole of this window, with exchange prompts layered on top of it.
  const inExchangePhase = !!finalRankings && exchangeStarted;

  // Table renders for ordinary live play AND for the exchange window -
  // the exchange modal/hand-return step both happen on top of the
  // real table, never on a separate screen.
  const showTableView = gameStarted && (isLivePlay || inExchangePhase);

  // The "give a card back" step is intentionally NOT a modal - the
  // requester picks straight from their normal hand fan.
  const inReturnStep = inExchangePhase && !!returnPrompt;

  const sortedFinalRankings = useMemo(() => {
    if (!finalRankings) return [];

    // finishedPlayers is authoritative and finishPosition is assigned
    // from that exact order on the server. Keep players in the final
    // standings even if they leave after finishing the round.
    return [...finalRankings].sort(
      (a, b) => a.finishPosition - b.finishPosition
    );
  }, [finalRankings]);

  const assholeResult =
    sortedFinalRankings.find((player) => player.rank === "Asshole") || null;
  const podiumPlayers = sortedFinalRankings
    .filter((player) => player.rank !== "Asshole")
    .slice(0, 3);
  const podiumIds = new Set(podiumPlayers.map((player) => player.id));
  const otherResults = sortedFinalRankings.filter(
    (player) => player.id !== assholeResult?.id && !podiumIds.has(player.id)
  );

  const playableRanks = myTurn
    ? computePlayableRanks(hand, tableCards)
    : new Set();

  const playControlsEnabled = sessionInteractionsEnabled && canUsePlayControls({
    roomPhase,
    isPlayerPresent: !!me,
    isLocalTurn: myTurn,
    isSpectator,
    isFinished: !!me?.finished,
  });

  const mustPass =
    playControlsEnabled &&
    tableCards.length > 0 &&
    hand.length > 0 &&
    playableRanks.size === 0;

  const canPass = playControlsEnabled && tableCards.length > 0;

  // Whoever's turn it currently is, by name - used by the status badge
  // so opponents see "Waiting for Ahmed to play..." instead of a
  // generic message. Only meaningful during live play; callers still
  // gate on isLivePlay/myTurn before using it.
  const turnPlayerName =
    players.find((p) => p.id === turnPlayerId)?.username || "the next player";

  const handPresentation = useMemo(
    () => getResponsiveHandLayout(hand.length, handWrapWidth),
    [hand.length, handWrapWidth]
  );
  const {
    cardWidth: handCardWidth,
    cardHeight: handCardHeight,
    contentWidth: handContentWidth,
    layout: handLayout,
    scrollable: handIsScrollable,
  } = handPresentation;

  const canSubmitPlay = sessionInteractionsEnabled && canSubmitSelectedPlay({
    roomPhase,
    isPlayerPresent: !!me,
    isLocalTurn: myTurn,
    isSpectator,
    isFinished: !!me?.finished,
    hand,
    selectedCards,
    tableCards,
    rankValues: RANK_VALUES,
  });

  return (
    <div
      className={`app-shell ${showTableView ? "app-shell-game" : ""}`}
      aria-busy={isReconnecting}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600..900&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');

        :root {
          --felt: #0b3d2e;
          --felt-dark: #072a20;
          --cream: #f6f1e4;
          --cream-dim: #ece3ce;
          --gold: #c9a24b;
          --gold-bright: #e8c468;
          --ink: #211a12;
          --ink-soft: #52493b;
          --ruby: #a5303a;
          --royal: #2c4a6e;
          --royal-bright: #3c6491;
        }

        * { box-sizing: border-box; }

        .app-shell {
          min-height: 100vh;
          width: 100%;
          font-family: 'Inter', sans-serif;
          color: var(--ink);
          background-color: var(--felt);
          background-image:
            radial-gradient(circle at 20% 20%, rgba(255,255,255,0.05), transparent 45%),
            url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Ctext x='10' y='30' font-size='22' fill='%23ffffff' fill-opacity='0.05'%3E%E2%99%A0%3C/text%3E%3Ctext x='70' y='75' font-size='22' fill='%23ffffff' fill-opacity='0.05'%3E%E2%99%A5%3C/text%3E%3Ctext x='30' y='105' font-size='22' fill='%23ffffff' fill-opacity='0.05'%3E%E2%99%A3%3C/text%3E%3Ctext x='90' y='40' font-size='22' fill='%23ffffff' fill-opacity='0.05'%3E%E2%99%A6%3C/text%3E%3C/svg%3E");
          background-repeat: repeat;
          padding: 48px 20px 80px;
        }

        /* The gameplay/table screen is a self-contained, non-scrolling
           viewport: a fixed-height flex column where every zone
           (topbar, status, hand, controls) takes only the space it
           needs and the table itself is the one flexible zone that
           absorbs whatever's left. This is what keeps the whole game
           on screen at once instead of relying on things happening to
           fit. */
        .app-shell-game {
          height: 100vh;
          height: 100dvh;
          min-height: 0;
          padding: 10px clamp(8px, 2vw, 20px);
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .game-screen {
          flex: 1 1 auto;
          min-height: 0;
          width: 100%;
          max-width: 1200px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
        }

        html, body, #root {
          width: 100%;
          min-width: 100%;
          min-height: 100%;
          margin: 0;
          padding: 0;
        }

        body { overflow-x: hidden; }

        .landing-logo {
          text-align: center;
          font-family: 'Fraunces', serif;
          font-weight: 800;
          font-size: 72px;
          letter-spacing: -1px;
          margin: 0;
          color: var(--gold-bright);
          text-shadow: 0 3px 0 rgba(0,0,0,0.35);
        }

        .landing-logo span { color: var(--cream); }

        .landing-sub {
          text-align: center;
          color: var(--cream-dim);
          font-size: 15px;
          letter-spacing: 3px;
          text-transform: uppercase;
          margin: 16px 0 28px;
        }

        .landing-card {
          max-width: 460px;
          margin: 0 auto;
          background: var(--cream);
          border-radius: 20px;
          padding: 28px;
          position: relative;
          box-shadow: 0 20px 50px rgba(0,0,0,0.35);
          border: 1px solid rgba(0,0,0,0.06);
        }

        .landing-card::before, .landing-card::after {
          content: '♠';
          position: absolute;
          font-family: 'Fraunces', serif;
          font-size: 20px;
          color: var(--gold);
          opacity: 0.6;
        }
        .landing-card::before { top: 14px; left: 10px; }
        .landing-card::after { bottom: 14px; right: 10px; transform: rotate(180deg); }

        .name-input {
          width: 100%;
          padding: 14px 16px;
          font-size: 16px;
          border-radius: 10px;
          border: 1px solid #d9cfb5;
          background: #fffdf8;
          font-family: 'Inter', sans-serif;
          color: var(--ink);
        }
        .name-input:focus { outline: 2px solid var(--gold); border-color: var(--gold); }

        .avatar-picker {
          margin-top: 18px;
          background: linear-gradient(160deg, var(--felt), var(--felt-dark));
          border-radius: 14px;
          padding: 16px 16px 18px;
        }

        .avatar-picker-label {
          margin: 0 0 12px;
          text-align: center;
          color: var(--cream-dim);
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 2px;
          font-weight: 600;
        }

        .btn {
          width: 100%;
          border: none;
          border-radius: 12px;
          padding: 15px;
          font-family: 'Inter', sans-serif;
          font-weight: 700;
          font-size: 16px;
          cursor: pointer;
          color: white;
        }
        .btn-play {
          margin-top: 20px;
          background: linear-gradient(180deg, #4fb35e, #379445);
          box-shadow: 0 6px 0 #276b31, 0 10px 18px rgba(0,0,0,0.25);
        }
        .btn-play:hover { filter: brightness(1.05); }
        .btn-play:active { transform: translateY(3px); box-shadow: 0 3px 0 #276b31; }
        .btn-play:disabled {
          opacity: 0.55;
          cursor: not-allowed;
          filter: none;
          transform: none;
        }

        .join-row {
          margin-top: 14px;
          display: flex;
          gap: 8px;
        }
        .join-row input {
          flex: 1;
          padding: 13px 14px;
          border-radius: 10px;
          border: 1px solid #d9cfb5;
          font-family: 'JetBrains Mono', monospace;
          letter-spacing: 2px;
          text-transform: uppercase;
          background: #fffdf8;
          color: var(--ink);
        }
        .btn-join {
          width: auto;
          padding: 0 20px;
          background: linear-gradient(180deg, var(--royal-bright), var(--royal));
          box-shadow: 0 6px 0 #1c3450, 0 10px 18px rgba(0,0,0,0.25);
        }
        .btn-join:active { transform: translateY(3px); box-shadow: 0 3px 0 #1c3450; }

        .info-grid {
          max-width: 980px;
          margin: 56px auto 0;
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 20px;
        }
        @media (max-width: 800px) {
          .info-grid { grid-template-columns: 1fr; }
          .landing-logo { font-size: 48px; }
        }

        .info-panel {
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 14px;
          padding: 20px 22px;
          color: var(--cream-dim);
        }
        .info-panel h3 {
          font-family: 'Fraunces', serif;
          color: var(--gold-bright);
          margin: 0 0 10px;
          font-size: 19px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .info-panel p, .info-panel li { font-size: 13.5px; line-height: 1.55; }
        .info-panel ul { margin: 0; padding-left: 18px; }
        .info-panel li { margin-bottom: 6px; }
        .info-panel .rank-line { display: flex; justify-content: space-between; margin-bottom: 8px; }
        .info-panel .rank-line b { color: var(--cream); }

        .room-shell {
          max-width: 640px;
          margin: 0 auto;
          background: var(--cream);
          border-radius: 18px;
          padding: 28px;
          box-shadow: 0 20px 50px rgba(0,0,0,0.35);
        }

        .room-shell h1 {
          font-family: 'Fraunces', serif;
          margin-top: 0;
          color: var(--felt);
        }

        .waiting-room-code {
          border: 1px solid rgba(25, 87, 65, 0.24);
          background: rgba(25, 87, 65, 0.08);
          color: var(--felt);
          border-radius: 10px;
          padding: 5px 10px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.78em;
          font-weight: 700;
          letter-spacing: 2px;
          cursor: pointer;
          vertical-align: middle;
          transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
        }
        .waiting-room-code:hover {
          background: rgba(25, 87, 65, 0.15);
          border-color: var(--felt);
        }
        .waiting-room-code:active { transform: translateY(1px); }
        .waiting-room-code.copied {
          color: #276b31;
          border-color: rgba(39, 107, 49, 0.45);
          background: rgba(79, 179, 94, 0.16);
        }

        .room-shell button { font-family: 'Inter', sans-serif; }

        .results-shell {
          max-width: 900px;
          margin: 24px auto 0;
          background: var(--cream);
          border-radius: 20px;
          padding: 34px;
          box-shadow: 0 20px 50px rgba(0,0,0,0.35);
          position: relative;
        }

        .results-shell::before, .results-shell::after {
          content: '♣';
          position: absolute;
          font-family: 'Fraunces', serif;
          font-size: 20px;
          color: var(--gold);
          opacity: 0.6;
        }
        .results-shell::before { top: 16px; left: 20px; }
        .results-shell::after { bottom: 16px; right: 20px; transform: rotate(180deg); }

        .results-title {
          font-family: 'Fraunces', serif;
          font-weight: 800;
          font-size: 30px;
          text-align: center;
          margin: 0 0 6px;
          color: var(--felt);
        }

        .results-subtitle {
          text-align: center;
          color: var(--ink-soft);
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 2px;
          margin: 0 0 26px;
        }

        .results-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 26px;
        }

        .results-featured {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 190px;
          gap: 18px;
          align-items: end;
          margin-bottom: 22px;
        }
        .podium {
          min-height: 250px;
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
          align-items: end;
        }
        .podium-card {
          position: relative;
          min-width: 0;
          padding: 18px 10px 14px;
          border: 1px solid rgba(0,0,0,0.08);
          border-radius: 14px 14px 8px 8px;
          background: linear-gradient(180deg, #fffdf8, #eee5d0);
          text-align: center;
          color: var(--ink);
          box-shadow: 0 8px 18px rgba(0,0,0,0.13);
        }
        .podium-card.podium-order-0 {
          grid-column: 2;
          grid-row: 1;
          min-height: 220px;
          padding-top: 28px;
          border-color: var(--gold);
          background: linear-gradient(180deg, #fff7d7, #e2c56f);
        }
        .podium-card.podium-order-1 {
          grid-column: 1;
          grid-row: 1;
          min-height: 174px;
          background: linear-gradient(180deg, #fbfbfb, #c7cbd0);
        }
        .podium-card.podium-order-2 {
          grid-column: 3;
          grid-row: 1;
          min-height: 145px;
          background: linear-gradient(180deg, #fff5ea, #c99365);
        }
        .podium-position {
          display: block;
          font-family: 'Fraunces', serif;
          font-size: 28px;
          font-weight: 800;
          color: var(--felt);
        }
        .podium-icon { display: block; font-size: 30px; margin: 6px 0; }
        .podium-name {
          display: block;
          overflow: hidden;
          font-weight: 800;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .podium-role {
          display: block;
          margin-top: 5px;
          font-family: 'Fraunces', serif;
          font-size: 13px;
          font-weight: 700;
        }
        .asshole-result {
          padding: 20px 14px;
          border: 2px dashed rgba(122,32,40,0.55);
          border-radius: 16px;
          background: linear-gradient(145deg, #f5dfd8, #d9aaa2);
          text-align: center;
          color: #65202a;
          transform: rotate(1deg);
          box-shadow: 0 8px 18px rgba(80,20,20,0.15);
        }
        .asshole-result-icon { display: block; font-size: 34px; }
        .asshole-result-name { display: block; margin: 6px 0; font-weight: 800; }
        .asshole-result-role {
          display: block;
          font-family: 'Fraunces', serif;
          font-size: 17px;
          font-weight: 800;
        }
        .other-results-title {
          margin: 0 0 8px;
          color: var(--ink-soft);
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 1.5px;
          text-transform: uppercase;
        }
        @media (max-width: 680px) {
          .results-shell { padding: 28px 18px; }
          .results-featured { grid-template-columns: 1fr; }
          .podium { min-height: 230px; }
          .asshole-result { transform: none; }
        }

        .results-row {
          display: flex;
          align-items: center;
          gap: 12px;
          background: rgba(0,0,0,0.04);
          border: 1px solid rgba(0,0,0,0.06);
          border-radius: 12px;
          padding: 10px 16px;
        }

        .results-row.me {
          border-color: var(--gold);
          background: rgba(201, 162, 75, 0.14);
        }

        .results-row .results-icon {
          font-size: 22px;
          width: 28px;
          text-align: center;
          flex-shrink: 0;
        }

        .results-row .results-name {
          flex: 1;
          font-weight: 600;
          font-size: 15px;
          color: var(--ink);
        }

        .results-row .results-role {
          font-family: 'Fraunces', serif;
          font-weight: 700;
          font-size: 14px;
          color: var(--ink-soft);
        }

        .results-actions {
          display: flex;
          gap: 12px;
        }

        .results-actions .btn { margin-top: 0; }

        .btn-exit {
          background: linear-gradient(180deg, #c25b5b, #a5303a);
          box-shadow: 0 6px 0 #7a2028, 0 10px 18px rgba(0,0,0,0.25);
        }
        .btn-exit:active { transform: translateY(3px); box-shadow: 0 3px 0 #7a2028; }

        .results-ready-note {
          text-align: center;
          color: var(--ink-soft);
          font-size: 13px;
          margin-top: 12px;
        }

        .finish-announcement-layer {
          position: fixed;
          inset: 0;
          z-index: 1100;
          display: flex;
          justify-content: center;
          align-items: flex-start;
          padding-top: clamp(70px, 12vh, 130px);
          pointer-events: none;
          overflow: hidden;
        }
        .finish-announcement {
          position: relative;
          z-index: 2;
          min-width: min(440px, calc(100vw - 32px));
          padding: 18px 28px;
          border: 1px solid rgba(255,255,255,0.3);
          border-radius: 16px;
          background: rgba(20, 48, 38, 0.94);
          color: var(--cream);
          text-align: center;
          box-shadow: 0 16px 42px rgba(0,0,0,0.42);
          animation: finishAnnouncementIn 0.35s cubic-bezier(.22,.8,.32,1);
        }
        .finish-announcement.president {
          border-color: var(--gold-bright);
          background: linear-gradient(145deg, rgba(20,48,38,0.97), rgba(92,66,16,0.96));
          box-shadow: 0 16px 42px rgba(0,0,0,0.42), 0 0 30px rgba(224,190,93,0.28);
        }
        .finish-announcement-name {
          display: block;
          margin-bottom: 4px;
          font-size: 14px;
          font-weight: 700;
          letter-spacing: 1.5px;
          text-transform: uppercase;
          color: var(--gold-bright);
        }
        .finish-announcement-result {
          display: block;
          font-family: 'Fraunces', serif;
          font-size: clamp(24px, 4vw, 34px);
          font-weight: 800;
        }
        .confetti-piece {
          position: absolute;
          top: -20px;
          left: var(--confetti-left);
          width: 9px;
          height: 15px;
          border-radius: 2px;
          background: var(--confetti-color);
          opacity: 0;
          transform: rotate(var(--confetti-rotation));
          animation: confettiFall var(--confetti-duration) ease-out var(--confetti-delay) forwards;
        }
        @keyframes finishAnnouncementIn {
          from { opacity: 0; transform: translateY(-18px) scale(0.96); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes confettiFall {
          0% { opacity: 1; transform: translate3d(0, -20px, 0) rotate(0deg); }
          100% { opacity: 0; transform: translate3d(var(--confetti-drift), 72vh, 0) rotate(720deg); }
        }

        .reconnecting-layer {
          position: fixed;
          inset: 0;
          z-index: 1300;
          display: flex;
          justify-content: center;
          align-items: flex-start;
          padding: clamp(18px, 5vh, 48px) 16px;
          background: rgba(7, 42, 32, 0.12);
          cursor: wait;
        }

        .reconnecting-banner {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: min(320px, calc(100vw - 32px));
          padding: 13px 18px;
          border: 1px solid rgba(232, 196, 104, 0.65);
          border-radius: 14px;
          color: var(--cream);
          background: rgba(7, 42, 32, 0.96);
          box-shadow: 0 14px 36px rgba(0,0,0,0.38);
        }

        .reconnecting-spinner {
          width: 22px;
          height: 22px;
          flex: 0 0 auto;
          border: 3px solid rgba(246, 241, 228, 0.28);
          border-top-color: var(--gold-bright);
          border-radius: 50%;
          animation: reconnectingSpin 0.8s linear infinite;
        }

        .reconnecting-copy {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .reconnecting-copy strong {
          font-family: 'Fraunces', serif;
          font-size: 18px;
        }

        .reconnecting-copy span {
          color: var(--cream-dim);
          font-size: 12px;
        }

        @keyframes reconnectingSpin {
          to { transform: rotate(360deg); }
        }

        @media (prefers-reduced-motion: reduce) {
          .reconnecting-spinner { animation: none; }
        }

        .exchange-overlay {
          position: fixed;
          inset: 0;
          z-index: 600;
          display: flex;
          align-items: flex-start;
          justify-content: center;
          padding: 20px;
          padding-top: min(8vh, 60px);
          /* Bottom padding roughly reserves the hand's on-screen space so
             the modal itself doesn't visually crowd it - the hand still
             renders above this overlay regardless (see z-index: 700 on
             .hand-scroll-viewport / .my-seat-row), this just keeps the modal
             from looking like it's stacked directly on top of it. */
          padding-bottom: 230px;
          overflow-y: auto;
          background: rgba(7, 42, 32, 0.55);
          backdrop-filter: blur(6px) brightness(0.75);
          -webkit-backdrop-filter: blur(6px) brightness(0.75);
          animation: overlayFadeIn 0.2s ease;
        }

        @keyframes overlayFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .exchange-modal {
          width: 100%;
          max-width: 480px;
          background: var(--cream);
          border-radius: 20px;
          padding: 30px;
          box-shadow: 0 24px 60px rgba(0,0,0,0.5);
          text-align: center;
        }

        .exchange-modal-title {
          font-family: 'Fraunces', serif;
          font-weight: 800;
          font-size: 24px;
          margin: 0 0 8px;
          color: var(--felt);
        }

        .exchange-modal-sub {
          color: var(--ink-soft);
          font-size: 14.5px;
          margin: 0 0 4px;
        }

        .exchange-modal-hint {
          color: var(--ink-soft);
          font-size: 12px;
          font-style: italic;
          margin: 0 0 18px;
        }

        .rank-tile-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(56px, 1fr));
          gap: 10px;
          margin-top: 6px;
        }

        .rank-tile {
          aspect-ratio: 5 / 7;
          background: #fffdf8;
          border: 1px solid #d8cfb8;
          border-radius: 8px;
          box-shadow: 0 3px 8px rgba(0,0,0,0.2);
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: 'Fraunces', serif;
          font-weight: 700;
          font-size: 20px;
          color: var(--ink);
          cursor: pointer;
          transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
        }

        .rank-tile:hover {
          transform: translateY(-4px);
          box-shadow: 0 8px 16px rgba(0,0,0,0.3);
          border-color: var(--gold);
        }

        .rank-tile-big-wrap {
          display: flex;
          justify-content: center;
          margin: 10px 0 16px;
        }

        .rank-tile-big {
          width: 90px;
          height: 126px;
          font-size: 44px;
          cursor: default;
        }
        .rank-tile-big:hover {
          transform: none;
          box-shadow: 0 3px 8px rgba(0,0,0,0.2);
          border-color: #d8cfb8;
        }

        .exchange-modal-actions {
          display: flex;
          gap: 12px;
          margin-top: 8px;
        }

        .exchange-modal-actions .btn {
          margin-top: 0;
        }

        .confirm-overlay {
          position: fixed;
          inset: 0;
          z-index: 950;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          background: rgba(7, 42, 32, 0.6);
          backdrop-filter: blur(6px) brightness(0.75);
          -webkit-backdrop-filter: blur(6px) brightness(0.75);
          animation: overlayFadeIn 0.2s ease;
        }

        .confirm-modal {
          width: 100%;
          max-width: 380px;
          background: var(--cream);
          border-radius: 20px;
          padding: 28px;
          box-shadow: 0 24px 60px rgba(0,0,0,0.5);
          text-align: center;
        }

        .confirm-modal-title {
          font-family: 'Fraunces', serif;
          font-weight: 800;
          font-size: 22px;
          margin: 0 0 8px;
          color: var(--felt);
        }

        .confirm-modal-sub {
          color: var(--ink-soft);
          font-size: 14.5px;
          margin: 0 0 20px;
        }

        .confirm-modal-actions {
          display: flex;
          gap: 12px;
        }

        .confirm-modal-actions .btn {
          margin-top: 0;
        }

        .request-card-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
          gap: 10px;
          margin-top: 14px;
        }

        .request-card {
          position: relative;
          aspect-ratio: 5 / 7;
          background: #fffdf8;
          border: 1px solid #d8cfb8;
          border-radius: 8px;
          box-shadow: 0 3px 8px rgba(0,0,0,0.2);
          cursor: pointer;
          padding: 0;
          transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
        }

        .request-card:hover {
          transform: translateY(-4px);
          box-shadow: 0 8px 16px rgba(0,0,0,0.3);
          border-color: var(--gold);
        }

        .request-card-corner {
          position: absolute;
          font-family: 'Fraunces', serif;
          font-weight: 700;
          font-size: 15px;
          color: var(--ink);
        }
        .request-card-corner-top { top: 6px; left: 8px; }
        .request-card-corner-bottom { bottom: 6px; right: 8px; transform: rotate(180deg); }

        .request-card-suits {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          letter-spacing: 1px;
          color: var(--ink-soft);
          opacity: 0.35;
        }

        .request-card-big-wrap {
          display: flex;
          justify-content: center;
          margin: 10px 0 16px;
        }

        .request-card.request-card-big {
          width: 90px;
          height: 126px;
          aspect-ratio: unset;
          cursor: default;
        }
        .request-card.request-card-big:hover {
          transform: none;
          box-shadow: 0 3px 8px rgba(0,0,0,0.2);
          border-color: #d8cfb8;
        }
        .request-card-big .request-card-corner { font-size: 22px; }
        .request-card-big .request-card-suits { font-size: 14px; }

        .request-card-joker {
          background: linear-gradient(160deg, #3c1361, #7b2ff7 60%, #b565f0);
          border-color: #d9a5ff;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 4px;
        }
        .request-card-joker:hover {
          border-color: var(--gold-bright);
        }
        .request-card-joker-icon {
          font-size: 22px;
          filter: drop-shadow(0 2px 3px rgba(0,0,0,0.4));
        }
        .request-card-joker-label {
          font-family: 'Fraunces', serif;
          font-weight: 700;
          font-size: 10px;
          color: var(--cream);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .request-card-big.request-card-joker .request-card-joker-icon {
          font-size: 40px;
        }
        .request-card-big.request-card-joker .request-card-joker-label {
          font-size: 13px;
        }

        .exchange-modal.joker-theme {
          background: linear-gradient(165deg, #2a0d4d, #5a1f9e 55%, #8b3fd6);
          box-shadow: 0 24px 60px rgba(90, 20, 160, 0.55);
        }
        .exchange-modal.joker-theme .exchange-modal-title {
          color: var(--gold-bright);
        }
        .exchange-modal.joker-theme .exchange-modal-sub {
          color: #e6d6ff;
        }

        .give-back-banner {
          position: relative;
          z-index: 700;
          max-width: min(94vw, 900px);
          margin: 6px auto 0;
          background: linear-gradient(180deg, var(--gold-bright), var(--gold));
          color: var(--ink);
          border-radius: 14px;
          padding: 12px 20px;
          text-align: center;
          font-family: 'Fraunces', serif;
          font-weight: 700;
          font-size: 16px;
          box-shadow: 0 10px 24px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.25) inset;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          animation: giveBackPulse 1.6s ease-in-out infinite;
        }

        .give-back-banner.confirm-variant {
          flex-direction: column;
          gap: 10px;
          animation: none;
          background: var(--cream);
          border: 1px solid var(--gold);
        }

        .confirm-banner-text {
          font-family: 'Inter', sans-serif;
          font-weight: 600;
          font-size: 14.5px;
        }

        .give-back-banner-icon {
          font-size: 18px;
        }

        .mini-confirm-actions {
          display: flex;
          gap: 10px;
          justify-content: center;
        }
        .mini-confirm-actions .btn {
          width: auto;
          margin-top: 0;
          padding: 9px 22px;
          font-size: 13.5px;
        }

        @keyframes giveBackPulse {
          0%, 100% { box-shadow: 0 10px 24px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.25) inset; }
          50% { box-shadow: 0 10px 30px rgba(0,0,0,0.5), 0 0 0 4px rgba(255,255,255,0.35) inset; }
        }

        .table-topbar {
          flex: 0 0 auto;
          width: 100%;
          min-height: 44px;
          margin: 0 0 10px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
          color: var(--cream-dim);
          font-size: 13px;
        }

        /* Room code badge - deliberately the loudest thing in the
           topbar (gold border + monospace code) so it reads instantly
           as "this is your table's address", separate from every
           other status/announcer element below it. Also doubles as a
           copy-to-clipboard button, hence position:relative (anchors
           the "Copied!" bubble) and the button reset below. */
        .room-badge {
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 10px;
          background: linear-gradient(180deg, rgba(0,0,0,0.38), rgba(0,0,0,0.24));
          border: 1.5px solid var(--gold);
          border-radius: 12px;
          padding: 7px 16px 7px 14px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06);
          flex-shrink: 0;
          cursor: pointer;
          font: inherit;
          transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease;
        }
        .room-badge:hover {
          border-color: var(--gold-bright);
          box-shadow: 0 5px 14px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08);
        }
        .room-badge:active {
          transform: translateY(1px);
        }
        .room-badge-label {
          font-family: 'Inter', sans-serif;
          font-weight: 700;
          font-size: 10.5px;
          letter-spacing: 2px;
          text-transform: uppercase;
          color: var(--gold);
        }
        .room-badge-divider {
          color: var(--gold);
          opacity: 0.6;
          font-size: 14px;
        }
        .room-badge-code {
          font-family: 'JetBrains Mono', monospace;
          font-weight: 700;
          font-size: 20px;
          letter-spacing: 4px;
          color: var(--gold-bright);
          text-shadow: 0 2px 6px rgba(0,0,0,0.4);
        }
        .room-badge-copy-icon {
          color: var(--gold);
          opacity: 0.7;
          flex-shrink: 0;
        }
        .room-badge:hover .room-badge-copy-icon {
          opacity: 1;
        }

        /* "Copied!" feedback - anchored below the badge so it can
           never collide with the badge itself or the leave button
           next to it, fades/scales in and clears itself on a timer. */
        .room-copied-toast {
          position: absolute;
          top: calc(100% + 8px);
          left: 50%;
          transform: translateX(-50%) translateY(-4px) scale(0.92);
          opacity: 0;
          background: rgba(15, 74, 55, 0.96);
          border: 1px solid var(--gold-bright);
          color: var(--gold-bright);
          font-family: 'Inter', sans-serif;
          font-weight: 700;
          font-size: 11.5px;
          letter-spacing: 0.5px;
          padding: 5px 12px;
          border-radius: 999px;
          white-space: nowrap;
          pointer-events: none;
          box-shadow: 0 6px 14px rgba(0,0,0,0.4);
          z-index: 30;
          animation: copiedToastIn 0.22s ease forwards;
        }
        @keyframes copiedToastIn {
          from {
            opacity: 0;
            transform: translateX(-50%) translateY(-4px) scale(0.92);
          }
          to {
            opacity: 1;
            transform: translateX(-50%) translateY(0) scale(1);
          }
        }
        @media (max-width: 480px) {
          .room-badge { padding: 6px 12px; gap: 7px; }
          .room-badge-code { font-size: 17px; letter-spacing: 3px; }
        }

        .status-row {
          flex: 0 0 auto;
          width: 100%;
          margin: 0 0 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-wrap: wrap;
          gap: 8px 14px;
        }

        .table-status-badge {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          background: rgba(0,0,0,0.32);
          border: 1px solid rgba(232,196,104,0.35);
          color: var(--gold-bright);
          font-family: 'Fraunces', serif;
          font-weight: 600;
          font-size: 13.5px;
          line-height: 1.3;
          padding: 6px 16px;
          border-radius: 999px;
          white-space: nowrap;
          max-width: 92vw;
          overflow: hidden;
          text-overflow: ellipsis;
          box-shadow: 0 3px 8px rgba(0,0,0,0.25);
        }

        .status-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--gold-bright);
          flex-shrink: 0;
          box-shadow: 0 0 6px rgba(232,196,104,0.7);
        }

        .spectator-row {
          margin: 0;
          display: flex;
          align-items: center;
          justify-content: flex-start;
          flex: 0 1 auto;
          flex-wrap: nowrap;
          gap: 12px;
          padding: 6px 14px;
          background: rgba(0,0,0,0.22);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 999px;
          width: max-content;
          min-width: 0;
          max-width: 100%;
          max-height: 42px;
          overflow-x: auto;
          overflow-y: hidden;
          white-space: nowrap;
          overscroll-behavior-inline: contain;
          scrollbar-width: thin;
          scrollbar-color: rgba(232, 196, 104, 0.65) rgba(0, 0, 0, 0.18);
          touch-action: pan-x pinch-zoom;
        }

        .spectator-row:focus-visible {
          outline: 2px solid var(--gold-bright);
          outline-offset: 2px;
        }

        .spectator-row::-webkit-scrollbar {
          height: 5px;
        }

        .spectator-row::-webkit-scrollbar-track {
          background: rgba(0, 0, 0, 0.18);
          border-radius: 999px;
        }

        .spectator-row::-webkit-scrollbar-thumb {
          background: rgba(232, 196, 104, 0.65);
          border-radius: 999px;
        }

        .spectator-label {
          flex: 0 0 auto;
          color: var(--cream-dim);
          font-size: 12px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 1px;
        }

        .spectator-chip {
          display: inline-flex;
          align-items: center;
          flex: 0 0 auto;
          gap: 6px;
          color: var(--cream-dim);
          font-size: 12.5px;
          font-weight: 600;
        }

        .leave-btn {
          display: inline-flex;
          align-items: center;
          gap: 9px;
          background: rgba(165, 48, 58, 0.22);
          border: 1.5px solid rgba(165, 48, 58, 0.7);
          color: #f8e2e2;
          border-radius: 11px;
          padding: 11px 20px;
          min-height: 44px;
          cursor: pointer;
          font-family: 'Inter', sans-serif;
          font-weight: 700;
          font-size: 13.5px;
          letter-spacing: 0.2px;
          flex-shrink: 0;
          box-shadow: 0 4px 10px rgba(0,0,0,0.3);
          transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease, color 0.15s ease, box-shadow 0.15s ease;
        }
        .leave-btn:hover {
          background: rgba(165, 48, 58, 0.4);
          border-color: #e2828a;
          color: #fff;
          box-shadow: 0 6px 14px rgba(0,0,0,0.4);
        }
        .leave-btn:active {
          transform: translateY(1px);
          background: rgba(165, 48, 58, 0.5);
          box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        }
        .leave-btn svg { flex-shrink: 0; }
        @media (max-width: 480px) {
          .leave-btn {
            padding: 11px 14px;
            gap: 0;
          }
          .leave-btn svg { width: 19px; height: 19px; }
          .leave-btn span { display: none; }
        }

        .table-oval {
          --seat-scale: 1;
          position: relative;
          flex: 1 1 auto;
          min-height: 220px;
          width: 100%;
          margin: 0;
          background: radial-gradient(ellipse at 50% 38%, #0f4a37, var(--felt-dark));
          border: 10px solid #6b4a26;
          border-radius: 46% / 30%;
          box-shadow: inset 0 0 60px rgba(0,0,0,0.5), 0 20px 40px rgba(0,0,0,0.4);
          /* Every seat sits on this ellipse and every piece of table
             furniture (current play + history) sits in the dead center -
             the two never compete for the same pixels because seats stop
             at the ellipse radius (see seatPosition) while the center
             zone is capped to a fixed max-width well inside that radius. */
        }

        /* Reserves the exact middle of the oval for table furniture,
           independent of how many seats ring the outside - it's centered
           via absolute + translate, not by leaving "space" between seats,
           so it can never collide with a seat regardless of player count. */
        .table-center-zone {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          z-index: 5;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: clamp(14px, 4vw, 34px);
          flex-wrap: wrap;
          max-width: min(72%, 480px);
          pointer-events: none;
        }
        .table-center-zone > * { pointer-events: auto; }

        .seat {
          position: absolute;
          transform: translate(-50%, -50%) scale(var(--seat-scale, 1)) scale(var(--seat-scale-mq, 1));
          transform-origin: center;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          z-index: 20;
          max-width: 40%;
        }
        .seat.seat-active {
          z-index: 40;
        }

        .fan-wrap {
          position: relative;
          width: 100px;
          height: 64px;
        }
        .fan-left { transform: rotate(0deg); margin-left: -20px; }
        .fan-right { margin-right: -20px; }

        .fan-card-back {
          position: absolute;
          left: 50%;
          top: 0;
          width: 34px;
          height: 50px;
          margin-left: -17px;
          border-radius: 5px;
          background: repeating-linear-gradient(45deg, var(--royal), var(--royal) 4px, var(--royal-bright) 4px, var(--royal-bright) 8px);
          border: 1.5px solid var(--cream);
          box-shadow: 0 3px 6px rgba(0,0,0,0.4);
          transform-origin: top center;
        }

        .seat-pill {
          background: rgba(165, 48, 58, 0.85);
          border: 1px solid rgba(255,255,255,0.2);
          border-radius: 999px;
          padding: 6px 14px;
          display: flex;
          align-items: center;
          gap: 7px;
          color: var(--cream);
          font-size: 13px;
          font-weight: 600;
          white-space: nowrap;
          box-shadow: 0 4px 10px rgba(0,0,0,0.35);
        }
        .seat-pill-me {
          box-shadow: 0 4px 10px rgba(0,0,0,0.35), 0 0 0 2px var(--gold-bright);
        }

        .seat-name {
          display: inline-block;
          max-width: 22vw;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          vertical-align: middle;
        }
        @media (max-width: 700px) {
          .seat-name { max-width: 26vw; }
        }

        .seat-pill.active {
          background: rgba(230, 180, 70, 0.95);
          color: var(--ink);
        }

        .avatar-circle {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: var(--cream);
          color: var(--ink);
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: 'Fraunces', serif;
          font-weight: 700;
          font-size: 12px;
          flex-shrink: 0;
        }
        .avatar-circle.has-avatar {
          font-size: 15px;
        }
        .avatar-circle.small {
          width: 20px;
          height: 20px;
          font-size: 12px;
        }

        .seat-count {
          opacity: 0.85;
          font-weight: 500;
          font-size: 12px;
        }

        .center-pile-container {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
        }

        .center-pile {
          position: relative;
          height: ${HAND_CARD_HEIGHT + 55}px;
          width: ${HAND_CARD_WIDTH + 130}px;
        }

        .center-pile.empty {
          height: auto;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          color: rgba(255,255,255,0.5);
          font-family: 'Fraunces', serif;
          font-style: italic;
          font-size: 13.5px;
          width: auto;
          white-space: nowrap;
          padding: 7px 16px;
          background: rgba(0, 0, 0, 0.28);
          border: 1px dashed rgba(255,255,255,0.22);
          border-radius: 999px;
        }

        .pile-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #8fd19e;
          box-shadow: 0 0 6px rgba(143,209,158,0.7);
          flex-shrink: 0;
        }

        .table-play-group {
          position: absolute;
          left: 50%;
          top: 50%;
          transition: transform 0.3s ease, opacity 0.3s ease;
        }

        .discard-pile-container {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          /* A hairline divider (not a hard edge) keeps this visually
             distinct from the current-play pile beside it, per the
             "current cards" vs "played card history" zones never
             blending together. */
          padding-left: clamp(10px, 3vw, 24px);
          border-left: 1px dashed rgba(255,255,255,0.16);
        }
        @media (max-width: 480px) {
          .discard-pile-container {
            padding-left: 0;
            border-left: none;
            padding-top: 10px;
            border-top: 1px dashed rgba(255,255,255,0.16);
          }
        }

        .discard-pile {
          position: relative;
          width: 58px;
          height: 82px;
        }

        .discard-placeholder {
          width: 100%;
          height: 100%;
          border: 1.5px dashed rgba(255, 255, 255, 0.2);
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: rgba(255, 255, 255, 0.25);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .discard-card-back {
          position: absolute;
          left: 50%;
          top: 50%;
          width: 58px;
          height: 82px;
          border-radius: 6px;
          background: repeating-linear-gradient(45deg, var(--royal), var(--royal) 4px, var(--royal-bright) 4px, var(--royal-bright) 8px);
          border: 1.5px solid var(--cream);
          box-shadow: 0 2px 6px rgba(0,0,0,0.35);
        }

        .discard-count-badge {
          background: rgba(0, 0, 0, 0.5);
          border: 1px solid rgba(255, 255, 255, 0.15);
          color: var(--cream-dim);
          padding: 3px 8px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 600;
          white-space: nowrap;
        }

        .table-card.stacked-card {
          position: absolute;
          left: 0;
          top: 0;
          width: ${HAND_CARD_WIDTH}px;
          height: ${HAND_CARD_HEIGHT}px;
          margin-left: ${-HAND_CARD_WIDTH / 2}px;
          margin-top: ${-HAND_CARD_HEIGHT / 2}px;
          background: var(--cream);
          border-radius: 10px;
          border: 1px solid #d8cfb8;
          box-shadow: 0 6px 14px rgba(0,0,0,0.35);
          transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
          font-size: 27px;
        }

        .table-card.stacked-card.latest-play {
          box-shadow: 0 6px 16px rgba(0, 0, 0, 0.45), 0 0 0 1px var(--gold-bright);
        }

        .pile-count-badge {
          background: rgba(0, 0, 0, 0.65);
          border: 1px solid rgba(255, 255, 255, 0.2);
          color: var(--gold-bright);
          padding: 4px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.5px;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
          pointer-events: none;
          white-space: nowrap;
        }

        .cf-corner {
          position: absolute;
          display: flex;
          flex-direction: column;
          align-items: center;
          line-height: 1;
          font-family: 'Fraunces', serif;
          font-weight: 700;
        }
        .cf-top { top: 8%; left: 10%; }
        .cf-bottom { bottom: 8%; right: 10%; transform: rotate(180deg); }
        .cf-rank { font-size: 1em; }
        .cf-suit { font-size: 0.76em; margin-top: -2px; }
        .cf-center {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 2.5em;
          opacity: 0.14;
        }
        .cf-red { color: var(--ruby); }
        .cf-black { color: var(--ink); }

        .flying-card {
          position: fixed;
          width: ${HAND_CARD_WIDTH}px;
          height: ${HAND_CARD_HEIGHT}px;
          background: var(--cream);
          border-radius: 10px;
          border: 1px solid #d8cfb8;
          box-shadow: 0 14px 28px rgba(0,0,0,0.5);
          font-size: 27px;
          pointer-events: none;
          z-index: 1000;
          transform-origin: center center;
          transition: transform 0.56s cubic-bezier(0.22, 0.9, 0.3, 1);
          will-change: transform;
        }

        .clearing-card-container {
          position: fixed;
          width: 60px;
          height: 84px;
          pointer-events: none;
          z-index: 1000;
          perspective: 1000px;
          transition: transform 0.6s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .clearing-card-inner {
          position: relative;
          width: 100%;
          height: 100%;
          transform-style: preserve-3d;
          transition: transform 0.6s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .clearing-card-container.active .clearing-card-inner {
          transform: rotateY(180deg);
        }

        .clearing-card-front, .clearing-card-back {
          position: absolute;
          inset: 0;
          backface-visibility: hidden;
          border-radius: 6px;
        }

        .clearing-card-front {
          background: var(--cream);
          border: 1px solid rgba(0,0,0,0.15);
          box-shadow: 0 6px 14px rgba(0,0,0,0.4);
          font-size: 14px;
        }

        .clearing-card-back {
          transform: rotateY(180deg);
          background: repeating-linear-gradient(45deg, var(--royal), var(--royal) 4px, var(--royal-bright) 4px, var(--royal-bright) 8px);
          border: 1.5px solid var(--cream);
          box-shadow: 0 6px 14px rgba(0,0,0,0.4);
        }

        .bottom-zone {
          flex: 0 0 auto;
          width: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: clamp(4px, 0.8vh, 8px);
        }

        .my-seat-row {
          position: relative;
          z-index: 700;
          width: 100%;
          margin: 0;
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 10px;
        }

        .sort-btn {
          border: 1px solid rgba(255,255,255,0.25);
          background: rgba(0,0,0,0.25);
          color: var(--cream-dim);
          border-radius: 999px;
          padding: 7px 16px;
          font-family: 'Inter', sans-serif;
          font-weight: 600;
          font-size: 12.5px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          white-space: nowrap;
        }
        .sort-btn:hover {
          color: var(--gold-bright);
          border-color: var(--gold-bright);
        }
        .sort-btn .arrow { font-size: 14px; }

        .hand-scroll-viewport {
          position: relative;
          z-index: 700;
          height: 185px;
          width: min(94vw, 900px);
          margin: 0 auto;
          flex-shrink: 0;
          overflow: visible;
        }

        .hand-scroll-viewport.scrollable {
          overflow-x: auto;
          overflow-y: hidden;
          overscroll-behavior-inline: contain;
          scrollbar-width: thin;
          scrollbar-color: rgba(232, 196, 104, 0.72) rgba(0, 0, 0, 0.2);
          touch-action: pan-x pinch-zoom;
        }

        .hand-scroll-viewport.scrollable:focus-visible {
          outline: 2px solid var(--gold-bright);
          outline-offset: 2px;
          border-radius: 10px;
        }

        .hand-scroll-viewport.scrollable::-webkit-scrollbar {
          height: 7px;
        }

        .hand-scroll-viewport.scrollable::-webkit-scrollbar-track {
          background: rgba(0, 0, 0, 0.2);
          border-radius: 999px;
        }

        .hand-scroll-viewport.scrollable::-webkit-scrollbar-thumb {
          background: rgba(232, 196, 104, 0.72);
          border-radius: 999px;
        }

        .hand-fan-wrap {
          position: relative;
          height: 185px;
          min-width: 100%;
        }

        .hand-scroll-viewport.scrollable .hand-fan-wrap {
          height: 177px;
        }

        .hand-scroll-viewport.scrollable .fan-card {
          touch-action: pan-x pinch-zoom;
        }

        .fan-card {
          position: absolute;
          left: 50%;
          bottom: 0;
          width: ${HAND_CARD_WIDTH}px;
          height: ${HAND_CARD_HEIGHT}px;
          margin-left: ${-HAND_CARD_WIDTH / 2}px;
          padding: 0;
          background: #fffdf8;
          border: 1px solid #d8cfb8;
          border-radius: 10px;
          box-shadow: 0 6px 14px rgba(0,0,0,0.35);
          cursor: grab;
          font-size: 27px;
          --lift: 0px;
          transform-origin: bottom center;
          transform: translateX(var(--x)) translateY(calc(var(--y) + var(--lift))) rotate(var(--rot));
          transition: transform 0.22s cubic-bezier(.22,.8,.32,1), box-shadow 0.2s ease, filter 0.15s ease, border-color 0.15s ease, opacity 0.2s ease;
          animation: fanCardIn 0.3s ease backwards;
        }

        .fan-card:active {
          cursor: grabbing;
        }

        .fan-card.dragging {
          opacity: 0.6;
          --lift: -28px;
          transform: translateX(var(--x)) translateY(calc(var(--y) + var(--lift))) rotate(var(--rot)) scale(1.08);
          z-index: 400 !important;
          box-shadow: 0 18px 32px rgba(0,0,0,0.5);
        }

        @keyframes fanCardIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .fan-card:disabled {
          cursor: not-allowed;
          filter: grayscale(0.55) brightness(0.82);
        }

        .fan-card.departing {
          opacity: 0;
          transition: opacity 0.06s linear;
        }

        .fan-card:not(:disabled):hover {
          --lift: -20px;
          box-shadow: 0 14px 26px rgba(0,0,0,0.4);
        }

        .fan-card.selected {
          --lift: -36px;
          border-color: var(--gold-bright);
          box-shadow: 0 16px 28px rgba(0,0,0,0.45), 0 0 0 2px var(--gold-bright);
        }

        .fan-card.playable:not(:disabled) {
          box-shadow: 0 0 0 3px var(--gold-bright), 0 10px 22px rgba(0,0,0,0.4);
        }

        .fan-card.playable.selected {
          box-shadow: 0 16px 28px rgba(0,0,0,0.45), 0 0 0 3px var(--gold-bright);
        }

        .action-bar {
          width: 100%;
          margin: 0;
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 14px;
          flex-shrink: 0;
        }
        .action-btn {
          border: none;
          border-radius: 10px;
          padding: 12px 26px;
          font-family: 'Inter', sans-serif;
          font-weight: 700;
          font-size: 15px;
          cursor: pointer;
          color: white;
        }
        .action-btn.play {
          background: linear-gradient(180deg, #4fb35e, #379445);
          box-shadow: 0 5px 0 #276b31;
        }
        .action-btn.pass {
          background: linear-gradient(180deg, #c25b5b, #a5303a);
          box-shadow: 0 5px 0 #7a2028;
        }
        .action-btn:active { transform: translateY(3px); box-shadow: none; }
        .action-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
          box-shadow: none;
          transform: none;
        }
        .action-btn.pass.suggested {
          animation: passPulse 1.3s ease-in-out infinite;
        }
        @keyframes passPulse {
          0%, 100% { box-shadow: 0 5px 0 #7a2028, 0 0 0 0 rgba(165,48,58,0.5); }
          50% { box-shadow: 0 5px 0 #7a2028, 0 0 0 8px rgba(165,48,58,0); }
        }
        .selected-count {
          color: var(--cream-dim);
          font-size: 13px;
        }

        .mini-card-row {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 8px;
        }
        .mini-card {
          position: relative;
          width: 64px;
          height: 90px;
          background: #fffdf8;
          border: 1px solid #d8cfb8;
          border-radius: 8px;
          box-shadow: 0 3px 8px rgba(0,0,0,0.25);
          font-size: 15px;
          padding: 0;
        }
        .mini-card-btn {
          cursor: pointer;
          transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        .mini-card-btn:hover {
          transform: translateY(-5px);
          box-shadow: 0 9px 16px rgba(0,0,0,0.3);
        }

        .debug-toggle-btn {
          position: fixed;
          left: 14px;
          bottom: 14px;
          z-index: 901;
          background: rgba(20, 0, 0, 0.55);
          border: 1px solid rgba(255, 82, 82, 0.55);
          color: #ffb3b3;
          border-radius: 999px;
          padding: 6px 12px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 10.5px;
          font-weight: 700;
          letter-spacing: 0.5px;
          cursor: pointer;
          opacity: 0.55;
          box-shadow: 0 4px 10px rgba(0,0,0,0.3);
          transition: opacity 0.15s ease, background 0.15s ease, border-color 0.15s ease;
        }
        .debug-toggle-btn:hover {
          opacity: 1;
          background: rgba(40, 0, 0, 0.7);
          border-color: #ff5252;
        }
        .debug-toggle-btn.open {
          opacity: 1;
          background: rgba(255, 82, 82, 0.18);
          border-color: #ff5252;
        }

        .debug-panel {
          position: fixed;
          left: 14px;
          bottom: 54px;
          z-index: 900;
          max-width: 260px;
          background: repeating-linear-gradient(135deg, #1a0000, #1a0000 10px, #2a0000 10px, #2a0000 20px);
          border: 2px dashed #ff5252;
          border-radius: 10px;
          padding: 12px 14px;
          box-shadow: 0 10px 24px rgba(0,0,0,0.5);
          font-family: 'JetBrains Mono', monospace;
        }

        .debug-panel-title {
          color: #ff8080;
          font-weight: 700;
          font-size: 12.5px;
          letter-spacing: 1px;
          text-transform: uppercase;
          margin-bottom: 6px;
        }

        .debug-panel-sub {
          color: #ffbdbd;
          font-size: 10px;
          line-height: 1.4;
          margin-bottom: 10px;
        }

        .debug-btn-row {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .debug-btn {
          display: flex;
          align-items: center;
          gap: 8px;
          background: rgba(255, 82, 82, 0.12);
          border: 1px solid #ff5252;
          color: #ffdada;
          border-radius: 6px;
          padding: 7px 10px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11.5px;
          font-weight: 700;
          cursor: pointer;
          text-align: left;
        }
        .debug-btn:hover {
          background: rgba(255, 82, 82, 0.28);
        }
        .debug-btn-icon {
          font-size: 14px;
        }

        @media (max-width: 700px) {
          .table-oval {
            border-radius: 38% / 24%;
          }
          .seat-pill {
            padding: 5px 10px;
            font-size: 11.5px;
            gap: 5px;
          }
          .avatar-circle {
            width: 20px;
            height: 20px;
            font-size: 10px;
          }
          .fan-wrap {
            width: 78px;
            height: 50px;
          }
          .fan-card-back {
            width: 26px;
            height: 38px;
            margin-left: -13px;
          }
          .discard-pile { width: 46px; height: 66px; }
          .table-status-badge {
            font-size: 12.5px;
            padding: 5px 13px;
          }
        }

        /* Height-based breakpoints keep the whole gameplay screen
           inside the viewport on shorter laptop windows and browsers
           with a lot of chrome. The table-oval is flexible already
           (it just absorbs whatever's left), so the only thing that
           needs to actively shrink here is the fixed-size hand zone -
           each step both lowers the box height AND scales the fan
           down to match, so the reclaimed space is real rather than
           just visually hidden. */
        @media (max-height: 820px) {
          .app-shell-game { padding-top: 8px; padding-bottom: 8px; }
          .table-oval { min-height: 150px; }
          .table-oval { --seat-scale-mq: 0.9; }
          .table-center-zone { transform: translate(-50%, -50%) scale(0.85); }
          .hand-scroll-viewport { height: 155px; }
          .hand-fan-wrap { height: 155px; }
          .hand-scroll-viewport:not(.scrollable) .hand-fan-wrap {
            height: 155px;
            transform: scale(0.88);
            transform-origin: bottom center;
          }
          .hand-scroll-viewport.scrollable .hand-fan-wrap { height: 147px; }
          .action-btn { padding: 10px 22px; }
        }

        @media (max-height: 680px) {
          .table-topbar { margin-bottom: 4px; }
          .status-row { margin-bottom: 4px; gap: 4px 10px; }
          .spectator-row {
            max-height: 36px;
            padding: 4px 10px;
            gap: 9px;
          }
          .table-oval { min-height: 130px; }
          .table-oval { --seat-scale-mq: 0.78; }
          .table-center-zone { transform: translate(-50%, -50%) scale(0.7); }
          .hand-scroll-viewport { height: 122px; }
          .hand-fan-wrap { height: 122px; }
          .hand-scroll-viewport:not(.scrollable) .hand-fan-wrap {
            height: 122px;
            transform: scale(0.7);
          }
          .hand-scroll-viewport.scrollable { height: 140px; }
          .hand-scroll-viewport.scrollable .hand-fan-wrap { height: 132px; }
          .action-btn { padding: 8px 18px; font-size: 13.5px; }
        }

        @media (max-height: 560px) {
          .table-oval { min-height: 110px; }
          .table-oval { --seat-scale-mq: 0.62; }
          .table-center-zone { transform: translate(-50%, -50%) scale(0.55); }
          .hand-scroll-viewport { height: 96px; }
          .hand-fan-wrap { height: 96px; }
          .hand-scroll-viewport:not(.scrollable) .hand-fan-wrap {
            height: 96px;
            transform: scale(0.55);
          }
          .hand-scroll-viewport.scrollable { height: 130px; }
          .hand-scroll-viewport.scrollable .hand-fan-wrap { height: 122px; }
          .sort-btn { padding: 5px 12px; font-size: 11px; }
        }

        @media (max-width: 480px) {
          .table-topbar {
            justify-content: center;
          }
        }
        /* Phone browser bars reduce the usable height, especially sideways.
           Preserve a readable table and allow scrolling instead of clipping
           controls or collapsing seats into the current play. */
        @media (max-width: 700px), (max-height: 500px) and (pointer: coarse) {
          .app-shell-game {
            height: auto;
            min-height: 100dvh;
            overflow: visible;
            padding-bottom: max(12px, env(safe-area-inset-bottom));
            padding-left: max(8px, env(safe-area-inset-left));
            padding-right: max(8px, env(safe-area-inset-right));
          }
          .game-screen { min-width: 0; }
          .table-oval {
            flex: 1 0 auto;
            min-height: 340px;
            margin-bottom: 12px;
            border-width: 6px;
          }
          .table-center-zone {
            flex-wrap: nowrap;
            gap: 10px;
            transform: translate(-50%, -50%) scale(0.65);
          }
          .hand-scroll-viewport { max-width: 100%; }
          .bottom-zone { gap: 10px; }
          .action-bar { flex-wrap: wrap; gap: 12px; padding-bottom: 6px; }
          .action-btn, .sort-btn, .leave-btn { min-height: 44px; }
          .action-btn { min-width: 80px; }
          .table-status-badge { white-space: normal; text-align: center; }
          .name-input { font-size: 16px; }
        }
        @media (orientation: landscape) and (max-height: 500px) and (pointer: coarse) {
          .table-oval {
            min-height: 300px;
            --seat-scale-mq: 0.78;
            border-radius: 38% / 30%;
          }
          .table-center-zone { transform: translate(-50%, -50%) scale(0.65); }
          .hand-scroll-viewport,
          .hand-scroll-viewport.scrollable { height: 155px; }
          .hand-scroll-viewport.scrollable .hand-fan-wrap { height: 147px; }
          .hand-scroll-viewport:not(.scrollable) .hand-fan-wrap {
            height: 155px;
            transform: scale(0.88);
          }
        }

      `}</style>

      {finishAnnouncement && (
        <div className="finish-announcement-layer" aria-live="polite">
          {finishAnnouncement.rank === "President" &&
            Array.from({ length: 30 }, (_, index) => (
              <span
                key={index}
                className="confetti-piece"
                style={{
                  "--confetti-left": `${3 + ((index * 37) % 94)}%`,
                  "--confetti-color": ["#e0be5d", "#f6e7b0", "#4fb35e", "#c25b5b", "#ffffff"][index % 5],
                  "--confetti-rotation": `${index * 29}deg`,
                  "--confetti-duration": `${1.9 + (index % 5) * 0.22}s`,
                  "--confetti-delay": `${(index % 8) * 0.08}s`,
                  "--confetti-drift": `${((index % 7) - 3) * 18}px`,
                }}
              />
            ))}
          <div
            className={`finish-announcement ${
              finishAnnouncement.rank === "President" ? "president" : ""
            }`}
            role="status"
          >
            <span className="finish-announcement-name">
              {finishAnnouncement.username} finished
            </span>
            <span className="finish-announcement-result">
              {finishAnnouncement.rank || "Nothing"} — {ordinal(finishAnnouncement.finishPosition)}
            </span>
          </div>
        </div>
      )}

      {!myRoom && (
        <>
          <h1 className="landing-logo">
            Asshole<span>.</span>
          </h1>
          <p className="landing-sub">a card game about climbing the ranks</p>

          <div className="landing-card">
            <input
              className="name-input"
              placeholder="Enter your name"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />

            <AvatarPicker value={selectedAvatar} onChange={setSelectedAvatar} />

            <button
              className="btn btn-play"
              onClick={createRoom}
              disabled={!sessionInteractionsEnabled}
            >
              Create Room
            </button>

            <div className="join-row">
              <input
                placeholder="Room code"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              />
              <button
                className="btn btn-join"
                onClick={joinRoom}
                disabled={!sessionInteractionsEnabled}
              >
                Join
              </button>
            </div>
          </div>

          <div className="info-grid">
            <div className="info-panel">
              <h3>🂡 About</h3>
              <p>
                President (also called Scum or Asshole) is a shedding game
                about hierarchy. Play cards in ascending strength to empty
                your hand first and rule as President — finish last and
                you're stuck as Asshole, handing your best cards to the
                President next round.
              </p>
            </div>

            <div className="info-panel">
              <h3>♟ The Hierarchy</h3>
              <div className="rank-line">
                <span>👑 President</span>
                <b>1st place</b>
              </div>
              <div className="rank-line">
                <span>🥈 Vice President</span>
                <b>2nd place</b>
              </div>
              <div className="rank-line">
                <span>🥉 Vice Asshole</span>
                <b>2nd-to-last</b>
              </div>
              <div className="rank-line">
                <span>💀 Asshole</span>
                <b>Last place</b>
              </div>
            </div>

            <div className="info-panel">
              <h3>🎲 How to Play</h3>
              <ul>
                <li>Get dealt a hand of cards</li>
                <li>Play cards of one rank, higher than what's on the table</li>
                <li>Can't beat it, or don't want to? Pass</li>
                <li>Empty your hand first to become President</li>
              </ul>
            </div>
          </div>
        </>
      )}

      {myRoom && showTableView && (
        <div className="game-screen">
          <div className="table-topbar">
            <button
              className="room-badge"
              onClick={copyRoomCode}
              aria-label={`Room code ${myRoom}, click to copy`}
              type="button"
            >
              <span className="room-badge-label">Room</span>
              <span className="room-badge-divider">·</span>
              <span className="room-badge-code">{myRoom}</span>
              <CopyIcon />
              {roomCodeCopied && (
                <span className="room-copied-toast" role="status">
                  Copied!
                </span>
              )}
            </button>

            <button
              className="leave-btn"
              onClick={requestLeaveRoom}
              aria-label="Leave table"
            >
              <ExitIcon />
              <span>Leave Table</span>
            </button>
          </div>

          <div className="status-row">
            <span className="table-status-badge">
              <span className="status-dot" />
              {isReconnecting
                ? "Reconnecting..."
                : inExchangePhase
                ? returnPrompt
                  ? `Choose a card to give to ${returnPrompt.responderUsername}`
                  : exchangeInfo
                    ? `Card exchange: ${exchangeInfo.requesterUsername} ↔ ${exchangeInfo.responderUsername}`
                    : "Exchange in progress..."
                : isSpectator
                  ? "Spectating this round — you'll be dealt in next round"
                  : hand.length === 0
                    ? "You're out — waiting for the round to finish"
                    : myTurn
                      ? mustPass
                        ? "Nothing beats the table — you'll need to pass"
                        : "Your turn — play a card"
                      : `Waiting for ${turnPlayerName} to play...`}
            </span>

            {spectatorPlayers.length > 0 && (
              <div
                className="spectator-row"
                tabIndex={0}
                aria-label={`${spectatorPlayers.length} spectator${
                  spectatorPlayers.length === 1 ? "" : "s"
                }`}
              >
                <span className="spectator-label">👀 Spectating</span>
                {spectatorPlayers.map((player) => (
                  <span key={player.id} className="spectator-chip">
                    <span className="avatar-circle small has-avatar">
                      <PlayerAvatar player={player} />
                    </span>
                    {player.username}
                    {player.id === socket.id && " (You)"}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div
            className="table-oval"
            style={{ "--seat-scale": seatScale(orderedSeatedPlayers.length) }}
          >
            {orderedSeatedPlayers.map((player, i) => (
              <PlayerSeat
                key={player.id}
                player={player}
                angle={tableSeatAngles[i]}
                isTurn={isLivePlay && player.id === turnPlayerId}
                isMe={player.id === socket.id}
                seatRef={(el) => (seatRefs.current[player.id] = el)}
                fanRef={(el) => (fanRefs.current[player.id] = el)}
              />
            ))}

            <div className="table-center-zone">
              <CenterPile playedGroups={playedGroups} pileRef={pileRef} />
              <DiscardPile count={discardedCardsCount} discardRef={discardRef} />
            </div>
          </div>

          {flyingCards.map((fc) => {
            const halfW = HAND_CARD_WIDTH / 2;
            const halfH = HAND_CARD_HEIGHT / 2;

            return (
              <div
                key={fc.id}
                className="flying-card"
                style={{
                  left: 0,
                  top: 0,
                  transform: fc.active
                    ? `translate3d(${fc.targetX - halfW}px, ${fc.targetY - halfH}px, 0) rotate(${fc.targetRot}deg) scale(1)`
                    : `translate3d(${fc.startX - halfW}px, ${fc.startY - halfH}px, 0) rotate(${fc.startRot}deg) scale(${fc.startScale ?? 0.92})`,
                }}
              >
                <CardFace card={fc.card} />
              </div>
            );
          })}

          {clearingCards.map((cc) => (
            <div
              key={cc.id}
              className={`clearing-card-container ${cc.active ? "active" : ""}`}
              style={{
                left: 0,
                top: 0,
                transform: cc.active
                  ? `translate3d(${cc.targetX - 30}px, ${cc.targetY - 41}px, 0)`
                  : `translate3d(${cc.startX - 30}px, ${cc.startY - 41}px, 0)`,
              }}
            >
              <div className="clearing-card-inner">
                <div className="clearing-card-front">
                  <CardFace card={cc.card} />
                </div>
                <div className="clearing-card-back" />
              </div>
            </div>
          ))}

          {hand.length > 0 && (
            <div className="bottom-zone">
              {inReturnStep && !pendingReturnCard && (
                <div className="give-back-banner">
                  <span className="give-back-banner-icon">🎁</span>
                  Choose a card to give to {returnPrompt?.responderUsername}
                </div>
              )}

              {inReturnStep && pendingReturnCard && (
                <div className="give-back-banner confirm-variant">
                  <div className="confirm-banner-text">
                    Give away{" "}
                    <b>
                      {pendingReturnCard.rank}
                      {pendingReturnCard.suit}
                    </b>{" "}
                    to {returnPrompt?.responderUsername}? Are you sure?
                  </div>
                  <div className="mini-confirm-actions">
                    <button
                      className="btn btn-play"
                      onClick={confirmReturnSelection}
                      disabled={!sessionInteractionsEnabled}
                    >
                      Yes
                    </button>
                    <button className="btn btn-exit" onClick={cancelReturnSelection}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div
                className={`hand-scroll-viewport ${
                  handIsScrollable ? "scrollable" : ""
                }`}
                ref={handWrapRef}
                tabIndex={handIsScrollable ? 0 : undefined}
                aria-label={
                  handIsScrollable
                    ? "Your cards, scroll horizontally to see the full hand"
                    : undefined
                }
              >
                <div
                  className="hand-fan-wrap"
                  style={{
                    width:
                      handIsScrollable && handContentWidth > 0
                        ? `${handContentWidth}px`
                        : "100%",
                  }}
                >
                  {hand.map((card, index) => {
                  const layout = handLayout[index] || { x: 0, y: 0, rotate: 0 };

                  const cardKey = `${card.rank}-${card.suit}`;

                  const isSelected = selectedCards.some(
                    (c) => c.rank === card.rank && c.suit === card.suit
                  );

                  const rankMismatch =
                    selectedCards.length > 0 &&
                    selectedCards[0].rank !== card.rank;

                  const maxReached = selectedCards.length >= 4 && !isSelected;

                  const leadBlocked =
                    selectedCards.length === 0 &&
                    tableCards.length > 0 &&
                    !playableRanks.has(card.rank);

                  // The "give a card back" step happens directly on this
                  // same hand fan, not in a modal - every card becomes
                  // clickable and clicking one returns it immediately.
                  const isDisabled = inReturnStep
                    ? !sessionInteractionsEnabled || !!pendingReturnCard
                    : !playControlsEnabled ||
                      rankMismatch ||
                      maxReached ||
                      leadBlocked;

                  const showPlayable = inReturnStep
                    ? true
                    : playControlsEnabled &&
                      (tableCards.length === 0 || playableRanks.has(card.rank));

                  const isDragging = draggedIndex === index;

                  // Hidden (not removed) while its thrown clone is
                  // mid-flight, so the same card never renders twice at
                  // once - the slot briefly stays reserved until "yourCards"
                  // truly removes it, so nothing else jumps to fill the gap.
                  const isDeparting = flyingSourceKeys.has(cardKey);

                    return (
                      <button
                      key={cardKey}
                      ref={(el) => (cardRefs.current[cardKey] = el)}
                      disabled={isDisabled || isDeparting}
                      draggable={!isDisabled && !isDeparting}
                      onDragStart={(e) => handleDragStart(e, index)}
                      onDragOver={(e) => handleDragOver(e, index)}
                      onDragEnd={handleDragEnd}
                      onClick={() =>
                        inReturnStep
                          ? setPendingReturnCard(card)
                          : selectCard(card)
                      }
                      className={`fan-card ${isSelected ? "selected" : ""} ${
                        showPlayable ? "playable" : ""
                      } ${isDragging ? "dragging" : ""} ${
                        isDeparting ? "departing" : ""
                      }`}
                      style={{
                        "--x": `${layout.x}px`,
                        "--y": `${layout.y}px`,
                        "--rot": `${layout.rotate}deg`,
                        width: `${handCardWidth}px`,
                        height: `${handCardHeight}px`,
                        marginLeft: `${-handCardWidth / 2}px`,
                        fontSize: `${handCardWidth * (27 / HAND_CARD_WIDTH)}px`,
                        zIndex: isDragging ? 400 : index,
                        animationDelay: `${index * 0.025}s`,
                      }}
                      >
                        <CardFace card={card} />
                      </button>
                    );
                  })}
                </div>
              </div>

              {me && hand.length > 1 && (
                <div className="my-seat-row">
                  <button
                    className="sort-btn"
                    onClick={toggleSort}
                    title="Toggle sort direction"
                    disabled={!sessionInteractionsEnabled}
                  >
                    <span className="arrow">
                      {sortDirection === "asc" ? "↑" : "↓"}
                    </span>
                    Sort Cards
                  </button>
                </div>
              )}

              {isLivePlay && (
                <div className="action-bar">
                  <button
                    className="action-btn play"
                    onClick={playCards}
                    disabled={!canSubmitPlay}
                  >
                    Play
                  </button>
                  <button
                    className={`action-btn pass ${mustPass ? "suggested" : ""}`}
                    onClick={passTurn}
                    disabled={!canPass}
                  >
                    Pass
                  </button>
                  <span className="selected-count">
                    {selectedCards.length} selected
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {myRoom && roomPhase === "WAITING" && !finalRankings && (
        <div className="room-shell">
          <h1>
            Room:{" "}
            <button
              type="button"
              className={`waiting-room-code ${roomCodeCopied ? "copied" : ""}`}
              onClick={copyRoomCode}
              aria-label={`Room code ${myRoom}, click to copy`}
            >
              {roomCodeCopied ? "Copied!" : myRoom}
            </button>
          </h1>

          <h3>Players:</h3>

          {players.map((player) => (
            <p key={player.id} className="lobby-player" style={{ opacity: player.spectator ? 0.6 : 1 }}>
              <span className="player-portrait lobby-portrait"><PlayerAvatar player={player} /></span>
              <span>
              {player.username}
              {player.host && " 👑"}
              {player.id === socket.id && " (You)"}
              {player.spectator && " — Spectating (joins next round)"}
              </span>
            </p>
          ))}

          {isHost && !gameStarted && (
            <button
              className="btn btn-play"
              onClick={startGame}
              disabled={!sessionInteractionsEnabled}
            >
              Start Game
            </button>
          )}

          {!isHost && !gameStarted && <p>Waiting for host...</p>}

          <button
            className="btn btn-exit"
            style={{ marginTop: 12 }}
            onClick={requestLeaveRoom}
          >
            Leave Room
          </button>
        </div>
      )}

      {myRoom && finalRankings && !exchangeStarted && (
        <div className="results-shell">
          <h2 className="results-title">Round Finished!</h2>
          <p className="results-subtitle">Final standings</p>

          <div className="results-featured">
            <div className="podium" aria-label="Winners podium">
              {podiumPlayers.map((player, index) => (
                <div
                  key={player.id}
                  className={`podium-card podium-order-${index} ${
                    player.id === socket.id ? "me" : ""
                  }`}
                >
                  <span className="podium-position">
                    {ordinal(player.finishPosition)}
                  </span>
                  <span className="podium-icon">
                    {ROLE_ICON[player.rank || "Nothing"]}
                  </span>
                  <span className="podium-name">
                    <span className="player-portrait podium-portrait"><PlayerAvatar player={player} /></span>
                    {player.username}
                    {player.id === socket.id && " (You)"}
                  </span>
                  <span className="podium-role">
                    {player.rank || "Nothing"}
                  </span>
                </div>
              ))}
            </div>

            {assholeResult && (
              <div className="asshole-result">
                <span className="asshole-result-icon">💀</span>
                <span className="asshole-result-name">
                  <span className="player-portrait podium-portrait"><PlayerAvatar player={assholeResult} /></span>
                  {assholeResult.username}
                  {assholeResult.id === socket.id && " (You)"}
                </span>
                <span className="asshole-result-role">Asshole</span>
                <span>{ordinal(assholeResult.finishPosition)}</span>
              </div>
            )}
          </div>

          {otherResults.length > 0 && (
            <>
              <p className="other-results-title">Other finishers</p>
              <div className="results-list">
                {otherResults.map((player) => (
                  <div
                    key={player.id}
                    className={`results-row ${player.id === socket.id ? "me" : ""}`}
                  >
                    <span className="results-icon">
                      {ROLE_ICON[player.rank || "Nothing"]}
                    </span>
                    <span className="results-name">
                      <span className="player-portrait results-portrait"><PlayerAvatar player={player} /></span>
                      {ordinal(player.finishPosition)} — {player.username}
                      {player.id === socket.id && " (You)"}
                    </span>
                    <span className="results-role">
                      {player.rank || "Nothing"}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="results-actions">
            <button
              className="btn btn-play"
              onClick={playAgain}
              disabled={readyClicked || !sessionInteractionsEnabled}
            >
              {readyClicked ? "Waiting for others..." : "Play Again"}
            </button>
            <button className="btn btn-exit" onClick={requestLeaveRoom}>
              Exit
            </button>
          </div>

          {readyClicked && (
            <p className="results-ready-note">
              {readyCount} / {readyTotal} players ready
            </p>
          )}
        </div>
      )}

      {inExchangePhase && (cardRequestPrompt || cardOffer) && (
        <div className="exchange-overlay">
          <div
            className={`exchange-modal ${
              cardRequestPrompt && pendingRankSelection === JOKER_RANK
                ? "joker-theme"
                : ""
            }`}
          >
            {cardRequestPrompt && !pendingRankSelection && (
              <>
                <h2 className="exchange-modal-title">Request a card</h2>
                <p className="exchange-modal-sub">
                  Pick a rank to request from{" "}
                  <b>{exchangeInfo.responderUsername}</b> — card{" "}
                  {cardRequestPrompt.requestNumber} of{" "}
                  {cardRequestPrompt.totalRequests}
                </p>
                <p className="exchange-modal-hint">
                  Suit doesn't matter — any card of that rank works
                </p>

                <div className="request-card-grid">
                  {REQUEST_RANKS.map((rank) => (
                    <RequestCardTile
                      key={rank}
                      rank={rank}
                      onClick={() => setPendingRankSelection(rank)}
                      disabled={!sessionInteractionsEnabled}
                    />
                  ))}
                </div>
              </>
            )}

            {cardRequestPrompt && pendingRankSelection && (
              <>
                <h2 className="exchange-modal-title">
                  {pendingRankSelection === JOKER_RANK
                    ? "Request the Joker?"
                    : "Confirm your request"}
                </h2>
                <p className="exchange-modal-sub">Are you sure?</p>

                <div className="request-card-big-wrap">
                  <RequestCardTile rank={pendingRankSelection} big />
                </div>

                <div className="exchange-modal-actions">
                  <button
                    className="btn btn-play"
                    onClick={confirmRankSelection}
                    disabled={!sessionInteractionsEnabled}
                  >
                    Yes
                  </button>
                  <button className="btn btn-exit" onClick={cancelRankSelection}>
                    Cancel
                  </button>
                </div>
              </>
            )}

            {cardOffer && (
              <>
                <h2 className="exchange-modal-title">
                  {cardOffer.requesterUsername} wants a card
                </h2>

                <div className="rank-tile-big-wrap">
                  <div className="rank-tile rank-tile-big">
                    {cardOffer.rank}
                  </div>
                </div>

                <p className="exchange-modal-sub">
                  {cardOffer.responderHasCard
                    ? "Give it up?"
                    : "You don't have one of these."}
                </p>

                <div className="exchange-modal-actions">
                  <button
                    className="btn btn-play"
                    onClick={() => respondToRequest(true)}
                    disabled={
                      !sessionInteractionsEnabled || !cardOffer.responderHasCard
                    }
                  >
                    Yes, give it
                  </button>
                  <button
                    className="btn btn-exit"
                    onClick={() => respondToRequest(false)}
                    disabled={!sessionInteractionsEnabled}
                  >
                    No
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {isReconnecting && (
        <div className="reconnecting-layer" role="status" aria-live="assertive">
          <div className="reconnecting-banner">
            <span className="reconnecting-spinner" aria-hidden="true" />
            <span className="reconnecting-copy">
              <strong>Reconnecting...</strong>
              <span>Restoring your game session</span>
            </span>
          </div>
        </div>
      )}

      {DEBUG_TOOLS_ENABLED && myRoom && (
        <button
          type="button"
          className={`debug-toggle-btn ${showDebugTools ? "open" : ""}`}
          onClick={() => setShowDebugTools((v) => !v)}
          disabled={!sessionInteractionsEnabled}
          aria-expanded={showDebugTools}
          aria-label={showDebugTools ? "Hide debug tools" : "Show debug tools"}
        >
          🐞 Debug Tools
        </button>
      )}

      {DEBUG_TOOLS_ENABLED && myRoom && showDebugTools && (
        <div className="debug-panel">
          <div className="debug-panel-title">🐞 Debug Tools</div>
          <div className="debug-panel-sub">
            Forces this player into an end-of-round rank to test the
            exchange flow. Testing the President/Asshole exchange needs
            at least one other connected player; Vice President/Vice
            Asshole needs 5+ players in the room (same as a real game).
          </div>
          <div className="debug-btn-row">
            {DEBUG_RANK_BUTTONS.map((b) => (
              <button
                key={b.rank}
                className="debug-btn"
                onClick={() => debugBecomeRank(b.rank)}
                disabled={!sessionInteractionsEnabled}
              >
                <span className="debug-btn-icon">{b.icon}</span>
                {b.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {showLeaveConfirm && (
        <div className="confirm-overlay">
          <div className="confirm-modal">
            <h2 className="confirm-modal-title">Leave the room?</h2>
            <p className="confirm-modal-sub">
              Are you sure you want to leave the room?
            </p>
            <div className="confirm-modal-actions">
              <button className="btn btn-play" onClick={cancelLeaveRoom}>
                Cancel
              </button>
              <button className="btn btn-exit" onClick={confirmLeaveRoom}>
                Leave Room
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
