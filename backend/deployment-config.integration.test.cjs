const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadConfiguration(environment = {}) {
  const serverPath = path.join(__dirname, "server.js");
  const source = `${fs.readFileSync(serverPath, "utf8")}
module.exports = {
  DEVELOPMENT_FRONTEND_ORIGIN,
  DEFAULT_SERVER_PORT,
  SERVER_PORT,
  resolveServerPort,
  allowedCorsOrigins,
  corsOptions,
  parseAllowedCorsOrigins,
};`;
  let expressCorsOptions;
  let socketServerOptions;
  let listenedPort;

  class MockSocketServer {
    constructor(_server, options) {
      socketServerOptions = options;
      this.sockets = { sockets: new Map() };
    }
    on() {}
    to() {
      return { emit() {} };
    }
  }

  const context = {
    module: { exports: {} },
    exports: {},
    Set,
    Map,
    process: { env: environment },
    console: { log() {}, warn() {}, error: console.error },
    setTimeout() { return {}; },
    clearTimeout() {},
    require(moduleName) {
      if (moduleName === "express") return () => ({ use() {} });
      if (moduleName === "cors") {
        return (options) => {
          expressCorsOptions = options;
          return function corsMiddleware() {};
        };
      }
      if (moduleName === "crypto") return require("crypto");
      if (moduleName === "url") return require("url");
      if (moduleName === "http") {
        return {
          createServer() {
            return {
              listen(port, callback) {
                listenedPort = port;
                callback?.();
              },
            };
          },
        };
      }
      if (moduleName === "socket.io") return { Server: MockSocketServer };
      throw new Error(`Unexpected module: ${moduleName}`);
    },
  };

  vm.runInNewContext(source, context, { filename: serverPath });

  return {
    ...context.module.exports,
    expressCorsOptions,
    socketServerOptions,
    listenedPort,
  };
}

function checkOrigin(corsOptions, origin) {
  let result;
  corsOptions.origin(origin, (error, allowed) => {
    result = { error, allowed };
  });
  return result;
}

// Development requires no configuration and permits only the Vite origin.
{
  const config = loadConfiguration();
  assert.strictEqual(
    config.DEVELOPMENT_FRONTEND_ORIGIN,
    "http://localhost:5173",
  );
  assert.strictEqual(config.DEFAULT_SERVER_PORT, 3001);
  assert.strictEqual(config.SERVER_PORT, 3001);
  assert.strictEqual(config.listenedPort, 3001);
  assert.deepStrictEqual(
    Array.from(config.allowedCorsOrigins),
    ["http://localhost:5173"],
  );
  assert.strictEqual(
    checkOrigin(config.corsOptions, "http://localhost:5173").allowed,
    true,
  );
  assert.match(
    checkOrigin(config.corsOptions, "https://wrong.example.com").error.message,
    /not allowed/,
  );
  assert.strictEqual(checkOrigin(config.corsOptions, undefined).allowed, true);
  assert.strictEqual(config.expressCorsOptions, config.corsOptions);
  assert.strictEqual(config.socketServerOptions.cors, config.corsOptions);
  let approvedUpgrade;
  config.socketServerOptions.allowRequest(
    { headers: { origin: "http://localhost:5173" } },
    (_error, allowed) => {
      approvedUpgrade = allowed;
    },
  );
  assert.strictEqual(approvedUpgrade, true);
  let rejectedUpgrade;
  config.socketServerOptions.allowRequest(
    { headers: { origin: "https://wrong.example.com" } },
    (_error, allowed) => {
      rejectedUpgrade = allowed;
    },
  );
  assert.strictEqual(rejectedUpgrade, false);
}

// Hosting platforms can provide their assigned numeric listening port.
{
  const config = loadConfiguration({ PORT: "8080" });

  assert.strictEqual(config.SERVER_PORT, 8080);
  assert.strictEqual(config.listenedPort, 8080);
  assert.strictEqual(config.resolveServerPort(" 4200 "), 4200);
}

// Invalid configured ports fail clearly at startup instead of silently
// binding an unexpected development port.
for (const invalidPort of ["", "0", "-1", "3001.5", "1e3", "65536", "abc"]) {
  assert.throws(
    () => loadConfiguration({ PORT: invalidPort }),
    /PORT must be an integer between 1 and 65535/,
  );
}

// Production supports exact, comma-separated frontend origins and normalizes
// a harmless trailing slash without broadening the allowlist.
{
  const config = loadConfiguration({
    CORS_ALLOWED_ORIGINS:
      "https://game.example.com/, https://staging.example.com",
  });
  assert.deepStrictEqual(Array.from(config.allowedCorsOrigins), [
    "https://game.example.com",
    "https://staging.example.com",
  ]);
  assert.strictEqual(
    checkOrigin(config.corsOptions, "https://game.example.com").allowed,
    true,
  );
  assert.strictEqual(
    checkOrigin(config.corsOptions, "https://staging.example.com").allowed,
    true,
  );
  assert.match(
    checkOrigin(config.corsOptions, "https://api.example.com").error.message,
    /not allowed/,
  );
}

// Wildcards and URL paths are rejected at startup rather than silently
// becoming a permissive production policy.
assert.throws(
  () => loadConfiguration({ CORS_ALLOWED_ORIGINS: "*" }),
  /CORS_ALLOWED_ORIGINS/,
);
assert.throws(
  () =>
    loadConfiguration({
      CORS_ALLOWED_ORIGINS: "https://game.example.com/socket-path",
    }),
  /CORS_ALLOWED_ORIGINS/,
);

console.log("deployment configuration integration tests passed");
