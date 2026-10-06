require("dotenv").config();
const express = require("express");
const morgan = require("morgan");

const userRoutes = require("./routes/users");
const productRoutes = require("./routes/products");
const orderRoutes = require("./routes/orders");
const adminRoutes = require("./routes/admin");
const { healthClients } = require("./clients/grpcClients");

const app = express();

app.use(express.json());
app.use(morgan("dev"));

app.use("/api/users", userRoutes);
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/admin", adminRoutes);

let shuttingDown = false;

// Liveness: the process is up and serving HTTP.
app.get("/health", (req, res) => res.json({ status: "ok", service: "api-gateway" }));

function checkService(client) {
  return new Promise((resolve) => {
    client.Check({ service: "" }, { deadline: Date.now() + 2000 }, (err, res) =>
      resolve(err ? "UNREACHABLE" : res.status)
    );
  });
}

// Readiness: every downstream service reports SERVING via grpc.health.v1.
app.get("/ready", async (req, res) => {
  const names = Object.keys(healthClients);
  const statuses = await Promise.all(names.map((n) => checkService(healthClients[n])));
  const dependencies = Object.fromEntries(names.map((n, i) => [n, statuses[i]]));
  const ready = !shuttingDown && statuses.every((s) => s === "SERVING");
  res
    .status(ready ? 200 : 503)
    .json({ status: ready ? "ok" : "unavailable", service: "api-gateway", dependencies });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`API Gateway running on port ${PORT}`));

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
