// Container health probe: node src/healthcheck.js [service]  (exit 0 = SERVING)
const grpc = require("@grpc/grpc-js");
const { service } = require("grpc-health-check");

const HealthClient = grpc.makeClientConstructor(service, "Health");
const client = new HealthClient(
  `localhost:${process.env.GRPC_PORT || 50052}`,
  grpc.credentials.createInsecure()
);

client.Check({ service: process.argv[2] || "" }, { deadline: Date.now() + 3000 }, (err, res) => {
  process.exit(!err && res.status === "SERVING" ? 0 : 1);
});
