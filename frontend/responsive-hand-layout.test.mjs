import assert from "node:assert/strict";
import fs from "node:fs";
import {
  getResponsiveHandLayout,
  MIN_HAND_CARD_EXPOSURE,
} from "./src/responsiveHandLayout.js";

const narrowMobileHandWidth = 320 * 0.94;

function assertUsableScrollableHand(count) {
  const result = getResponsiveHandLayout(count, narrowMobileHandWidth);

  assert.strictEqual(result.scrollable, true, `${count} cards should scroll`);
  assert.ok(
    result.contentWidth > narrowMobileHandWidth,
    `${count} cards need an overflow canvas`,
  );
  assert.ok(
    result.exposedWidth >= MIN_HAND_CARD_EXPOSURE - 0.001,
    `${count} cards must expose at least ${MIN_HAND_CARD_EXPOSURE}px each`,
  );
  assert.ok(result.cardScale >= 0.72, `${count} cards must stay readable`);
  assert.strictEqual(result.layout.length, count);

  for (let index = 1; index < result.layout.length; index += 1) {
    assert.ok(
      result.layout[index].x > result.layout[index - 1].x,
      "cards must remain ordered and independently reachable left-to-right",
    );
  }
}

assertUsableScrollableHand(26);
assertUsableScrollableHand(13);

// Existing desktop/large-monitor geometry remains the non-scrolling fan. The
// rendered hand is capped at 900px in CSS, so that is the meaningful width on
// both ordinary desktops and larger displays.
for (const count of [13, 26]) {
  const desktop = getResponsiveHandLayout(count, 900);
  assert.strictEqual(desktop.scrollable, false, `${count}-card desktop fan stays unchanged`);
  assert.ok(desktop.cardScale <= 1);
  assert.ok(desktop.exposedWidth >= MIN_HAND_CARD_EXPOSURE);
}

const largeMonitor = getResponsiveHandLayout(13, 1600);
assert.strictEqual(largeMonitor.scrollable, false);
assert.strictEqual(largeMonitor.cardScale, 1);

// The checked-in JSX keeps the same click/drag handlers and places the fixed
// height scroll viewport before the separate Sort and action rows.
const appSource = fs.readFileSync(new URL("./src/App.jsx", import.meta.url), "utf8");
const handStart = appSource.indexOf('className={`hand-scroll-viewport');
const sortStart = appSource.indexOf('className="my-seat-row"', handStart);
const actionsStart = appSource.indexOf('className="action-bar"', handStart);

assert.notStrictEqual(handStart, -1);
assert.ok(sortStart > handStart);
assert.ok(actionsStart > sortStart);
assert.match(appSource, /tabIndex=\{handIsScrollable \? 0 : undefined\}/);
assert.match(appSource, /onClick=\{\(\) =>\s*inReturnStep/);
assert.match(appSource, /onDragStart=\{\(e\) => handleDragStart\(e, index\)\}/);
assert.match(appSource, /onDragOver=\{\(e\) => handleDragOver\(e, index\)\}/);
assert.match(appSource, /zIndex: isDragging \? 400 : index/);
assert.match(appSource, /\.hand-scroll-viewport \{[\s\S]*?height: 185px/);

console.log("Responsive hand-layout tests passed.");
