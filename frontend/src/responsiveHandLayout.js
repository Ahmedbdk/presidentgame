export const HAND_CARD_WIDTH = 105;
export const HAND_CARD_HEIGHT = 147;
export const MIN_HAND_CARD_EXPOSURE = 30;

const HAND_CARD_MIN_SCALE = 0.55;
const HAND_CARD_MAX_SCALE = 1;
const SCROLLABLE_HAND_MIN_SCALE = 0.72;
const OUTER_CARD_ROTATION_RADIANS = 16 * (Math.PI / 180);

function getOuterCardOverhang(cardWidth) {
  const cardHeight = cardWidth * (HAND_CARD_HEIGHT / HAND_CARD_WIDTH);
  const rotatedOuterWidth =
    Math.cos(OUTER_CARD_ROTATION_RADIANS) * cardWidth +
    Math.sin(OUTER_CARD_ROTATION_RADIANS) * cardHeight;

  return Math.max(0, (rotatedOuterWidth - cardWidth) / 2);
}

export function getHandLayout(count, containerWidth, cardWidth) {
  if (count <= 0) return [];

  const resolvedCardWidth = cardWidth > 0 ? cardWidth : HAND_CARD_WIDTH;
  const edgeOverhang = getOuterCardOverhang(resolvedCardWidth);
  const width =
    containerWidth > 0
      ? Math.max(
          resolvedCardWidth,
          containerWidth - edgeOverhang * 2 - 4,
        )
      : resolvedCardWidth * count;

  const maxStep = resolvedCardWidth * 0.48;
  let step =
    count <= 1 ? 0 : (width - resolvedCardWidth) / (count - 1);
  step = Math.min(Math.max(step, 0), maxStep);

  const totalWidth = resolvedCardWidth + step * (count - 1);
  const startX = -totalWidth / 2 + resolvedCardWidth / 2;
  const maxRotate = count <= 1 ? 0 : 16;
  const domeDrop = resolvedCardWidth * (22 / HAND_CARD_WIDTH);

  return Array.from({ length: count }, (_, index) => {
    const normalizedPosition =
      count <= 1
        ? 0
        : (index - (count - 1) / 2) / ((count - 1) / 2);

    return {
      x: startX + index * step,
      y: normalizedPosition * normalizedPosition * domeDrop,
      rotate: normalizedPosition * maxRotate,
    };
  });
}

export function computeHandCardScale(count, containerWidth) {
  if (count <= 0 || containerWidth <= 0) return HAND_CARD_MAX_SCALE;

  const overlapFactor = 0.34;
  const usableWidth = containerWidth * 0.96;
  const neededWidthAtFullScale =
    HAND_CARD_WIDTH * (1 + overlapFactor * (count - 1));

  if (neededWidthAtFullScale <= usableWidth) {
    return HAND_CARD_MAX_SCALE;
  }

  const scale = usableWidth / neededWidthAtFullScale;

  return Math.min(
    HAND_CARD_MAX_SCALE,
    Math.max(HAND_CARD_MIN_SCALE, scale),
  );
}

function getExposedWidth(layout, cardWidth) {
  if (layout.length <= 1) return cardWidth;
  return layout[1].x - layout[0].x;
}

function getScrollableContentWidth(count, cardWidth) {
  const edgeOverhang = getOuterCardOverhang(cardWidth);

  return (
    cardWidth +
    MIN_HAND_CARD_EXPOSURE * Math.max(0, count - 1) +
    edgeOverhang * 2 +
    4
  );
}

export function getResponsiveHandLayout(count, availableWidth) {
  const normalScale = computeHandCardScale(count, availableWidth);
  const normalCardWidth = HAND_CARD_WIDTH * normalScale;
  const normalCardHeight = HAND_CARD_HEIGHT * normalScale;
  const normalLayout = getHandLayout(
    count,
    availableWidth,
    normalCardWidth,
  );
  const normalExposure = getExposedWidth(normalLayout, normalCardWidth);
  const scrollable =
    availableWidth > 0 &&
    count > 1 &&
    normalExposure < MIN_HAND_CARD_EXPOSURE;

  if (!scrollable) {
    return {
      cardScale: normalScale,
      cardWidth: normalCardWidth,
      cardHeight: normalCardHeight,
      contentWidth: availableWidth,
      exposedWidth: normalExposure,
      layout: normalLayout,
      scrollable: false,
    };
  }

  const cardScale = Math.max(normalScale, SCROLLABLE_HAND_MIN_SCALE);
  const cardWidth = HAND_CARD_WIDTH * cardScale;
  const cardHeight = HAND_CARD_HEIGHT * cardScale;
  const contentWidth = getScrollableContentWidth(count, cardWidth);
  const layout = getHandLayout(count, contentWidth, cardWidth);

  return {
    cardScale,
    cardWidth,
    cardHeight,
    contentWidth,
    exposedWidth: getExposedWidth(layout, cardWidth),
    layout,
    scrollable: true,
  };
}
