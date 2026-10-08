import { useEffect, useRef } from "react";
import "./avatars.css";

export const AVATAR_OPTIONS = Array.from({ length: 12 }, (_, i) => `c${i + 1}`);
const avatarUrl = (avatar) => `/avatars/optimized/${avatar}.png`;

export function PlayerAvatar({ player }) {
  return AVATAR_OPTIONS.includes(player.avatar) ? (
    <img className="player-avatar-image" src={avatarUrl(player.avatar)} alt="" draggable={false} />
  ) : (player.avatar || player.username?.[0]?.toUpperCase() || "?");
}

export function AvatarPicker({ value, onChange }) {
  const start = useRef(null);
  const index = Math.max(0, AVATAR_OPTIONS.indexOf(value));
  useEffect(() => {
    // Warm the adjacent choices before a swipe, including wraparound.
    for (const offset of [-1, 1, 2]) {
      const image = new Image();
      image.src = avatarUrl(AVATAR_OPTIONS[(index + offset + AVATAR_OPTIONS.length) % AVATAR_OPTIONS.length]);
    }
  }, [index]);
  function move(direction) {
    onChange(AVATAR_OPTIONS[(index + direction + AVATAR_OPTIONS.length) % AVATAR_OPTIONS.length]);
  }
  return (
    <div className="avatar-picker">
      <p className="avatar-picker-label" id="avatar-picker-label">Choose your avatar</p>
      <div className="avatar-carousel" role="group" aria-labelledby="avatar-picker-label"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            move(event.key === "ArrowLeft" ? -1 : 1);
          }
        }}>
        <button type="button" className="avatar-arrow" aria-label="Previous avatar" onClick={() => move(-1)}>‹</button>
        <div className="avatar-preview" tabIndex={0} aria-label="Swipe or use arrow keys to choose an avatar"
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return;
            start.current = { x: event.clientX, y: event.clientY };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { start.current = null; }}
          onPointerUp={(event) => {
            const previous = start.current;
            start.current = null;
            if (!previous) return;
            const dx = event.clientX - previous.x;
            const dy = event.clientY - previous.y;
            if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy)) move(dx < 0 ? 1 : -1);
          }}>
          <img src={avatarUrl(value)} alt={`Avatar ${index + 1}`} draggable={false} />
        </div>
        <button type="button" className="avatar-arrow" aria-label="Next avatar" onClick={() => move(1)}>›</button>
      </div>
      <p className="avatar-position" aria-live="polite" aria-atomic="true">{index + 1} / {AVATAR_OPTIONS.length}</p>
    </div>
  );
}
