require("dotenv").config();
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const mongoose = require("mongoose");
const path = require("path");
const handlers = require("./handlers/orderHandler");
const rabbitmq = require("./rabbitmq/publisher");
const { health, trackMongo, bindServer, handleShutdown, fatal } = require("./lifecycle");

const PROTO_PATH = path.join(__dirname, "../../../proto/order.proto");

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const orderProto = grpc.loadPackageDefinition(packageDef).order;

async function main() {
  trackMongo();
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/orders");
  console.log("Connected to MongoDB");

  // RabbitMQ only feeds notifications, so it isn't a readiness dependency;
  // the publisher keeps retrying in the background instead of blocking startup.
  rabbitmq.connect();

  const server = new grpc.Server();
  server.addService(orderProto.OrderService.service, handlers);
  health.addToServer(server);

  const PORT = process.env.GRPC_PORT || 50053;
  await bindServer(server, PORT);
  console.log(`Order Service gRPC running on port ${PORT}`);

  handleShutdown(server, () => rabbitmq.close());
}

main().catch(fatal);
