const grpc = require("@grpc/grpc-js");
const mongoose = require("mongoose");
const { HealthImplementation } = require("grpc-health-check");

// Standard grpc.health.v1 service.
//   ""         -> readiness: SERVING only while every hard dependency is up
//   "liveness" -> SERVING while the process is running (don't restart pods because Mongo blipped)
const health = new HealthImplementation({ "": "NOT_SERVING", liveness: "SERVING" });
const dependencies = {};
let shuttingDown = false;

function setDependency(name, up) {
  dependencies[name] = up;
  if (shuttingDown) return;
  const ready = Object.values(dependencies).every(Boolean);
  health.setStatus("", ready ? "SERVING" : "NOT_SERVING");
}

function trackMongo() {
  setDependency("mongo", false);
  mongoose.connection.on("connected", () => setDependency("mongo", true));
  mongoose.connection.on("reconnected", () => setDependency("mongo", true));
  mongoose.connection.on("disconnected", () => {
    console.warn("MongoDB disconnected");
    setDependency("mongo", false);
  });
}

function bindServer(server, port) {
  return new Promise((resolve, reject) => {
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) =>
      err ? reject(err) : resolve(boundPort)
    );
  });
}

// Stop taking new RPCs, let in-flight ones finish, then close connections.
function handleShutdown(server, cleanup = async () => {}) {
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    health.setStatus("", "NOT_SERVING");

    setTimeout(() => {
      console.error("Graceful shutdown timed out, forcing exit");
      server.forceShutdown();
      process.exit(1);
    }, 10_000).unref();

    server.tryShutdown(async () => {
      try {
        await cleanup();
        await mongoose.disconnect();
      } finally {
        process.exit(0);
      }
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function fatal(err) {
  console.error("Fatal startup error:", err);
  process.exit(1);
}

module.exports = { health, setDependency, trackMongo, bindServer, handleShutdown, fatal };
