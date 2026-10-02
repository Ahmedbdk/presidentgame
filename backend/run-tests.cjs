const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const testDirectory = __dirname;
const testFiles = fs
  .readdirSync(testDirectory)
  .filter((fileName) => fileName.endsWith(".test.cjs"))
  .sort();

if (testFiles.length === 0) {
  console.error("No backend test suites were found.");
  process.exit(1);
}

for (const testFile of testFiles) {
  console.log(`\n> ${testFile}`);

  const result = spawnSync(process.execPath, [path.join(testDirectory, testFile)], {
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`\nAll ${testFiles.length} backend test suites passed.`);
