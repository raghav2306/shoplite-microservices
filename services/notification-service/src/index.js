require("dotenv").config();
const http = require("http");
const { startConsumer, stopConsumer, isConnected } = require("./rabbitmq/consumer");

const HEALTH_PORT = process.env.HEALTH_PORT || 8080;

// /healthz -> liveness (process up); /readyz -> consuming from RabbitMQ
const healthServer = http.createServer((req, res) => {
  const ready = isConnected();
  const routes = {
    "/healthz": [200, { status: "ok" }],
    "/readyz": [ready ? 200 : 503, { status: ready ? "ok" : "unavailable", rabbitmq: ready }],
  };
  const [code, body] = routes[req.url] || [404, { error: "Not found" }];
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ...body, service: "notification-service" }));
});

async function main() {
  healthServer.listen(HEALTH_PORT, () => console.log(`Health endpoint on port ${HEALTH_PORT}`));
  await startConsumer();
  console.log("Notification Service started");
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref();
  healthServer.close();
  await stopConsumer().catch((err) => console.error("Error closing RabbitMQ:", err.message));
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
