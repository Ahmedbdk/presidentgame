import assert from "node:assert/strict";
import fs from "node:fs";

const appSource = fs.readFileSync(new URL("./src/App.jsx", import.meta.url), "utf8");

function cssRule(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = appSource.match(
    new RegExp(`${escapedSelector} \\{([\\s\\S]*?)\\n        \\}`),
  );
  assert.ok(match, `Expected ${selector} CSS rule`);
  return match[1];
}

const spectatorRow = cssRule(".spectator-row");

// Narrow windows and the maximum eight-seat room must keep one compact line;
// intrinsic overflow belongs to the strip rather than the gameplay shell.
assert.match(spectatorRow, /flex-wrap:\s*nowrap/);
assert.match(spectatorRow, /width:\s*max-content/);
assert.match(spectatorRow, /min-width:\s*0/);
assert.match(spectatorRow, /max-width:\s*100%/);
assert.match(spectatorRow, /max-height:\s*42px/);
assert.match(spectatorRow, /overflow-x:\s*auto/);
assert.match(spectatorRow, /overflow-y:\s*hidden/);
assert.match(spectatorRow, /white-space:\s*nowrap/);
assert.match(spectatorRow, /touch-action:\s*pan-x pinch-zoom/);

// Labels and individual spectators cannot shrink into unreadable fragments.
assert.match(cssRule(".spectator-label"), /flex:\s*0 0 auto/);
assert.match(cssRule(".spectator-chip"), /flex:\s*0 0 auto/);

// Short laptop screens use an even smaller fixed ceiling instead of gaining
// another row and pushing the table/hand/control zones out of view.
assert.match(
  appSource,
  /@media \(max-height: 680px\) \{[\s\S]*?\.spectator-row \{[\s\S]*?max-height:\s*36px;[\s\S]*?padding:\s*4px 10px;[\s\S]*?\}/,
);

// Every spectator remains rendered with their existing avatar and name. The
// scrollable strip is keyboard-focusable and labelled for assistive software.
assert.match(appSource, /tabIndex=\{0\}/);
assert.match(
  appSource,
  /aria-label=\{`\$\{spectatorPlayers\.length\} spectator/,
);
assert.match(appSource, /spectatorPlayers\.map\(\(player\) => \(/);
assert.match(appSource, /player\.avatar \|\| player\.username\?\.\[0\]/);
assert.match(appSource, /\{player\.username\}/);

// The spectator strip remains in the status zone, before the flexible table;
// the hand and controls retain their separate fixed bottom zone.
const statusIndex = appSource.indexOf('className="status-row"');
const spectatorIndex = appSource.indexOf('className="spectator-row"', statusIndex);
const tableIndex = appSource.indexOf('className="table-oval"', spectatorIndex);
const bottomIndex = appSource.indexOf('className="bottom-zone"', tableIndex);

assert.ok(statusIndex >= 0);
assert.ok(spectatorIndex > statusIndex);
assert.ok(tableIndex > spectatorIndex);
assert.ok(bottomIndex > tableIndex);
assert.match(cssRule(".status-row"), /flex:\s*0 0 auto/);
assert.match(cssRule(".table-oval"), /flex:\s*1 1 auto/);
assert.match(cssRule(".bottom-zone"), /flex:\s*0 0 auto/);

console.log("Spectator strip layout tests passed.");
