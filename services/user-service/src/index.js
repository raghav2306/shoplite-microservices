require("dotenv").config();
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const mongoose = require("mongoose");
const path = require("path");
const handlers = require("./handlers/userHandler");
const { health, trackMongo, bindServer, handleShutdown, fatal } = require("./lifecycle");

const PROTO_PATH = path.join(__dirname, "../../../proto/user.proto");

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const userProto = grpc.loadPackageDefinition(packageDef).user;

async function main() {
  trackMongo();
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/users");
  console.log("Connected to User-Service MongoDB");

  const server = new grpc.Server();
  server.addService(userProto.UserService.service, handlers);
  health.addToServer(server);

  const PORT = process.env.GRPC_PORT || 50051;
  await bindServer(server, PORT);
  console.log(`User Service gRPC running on port ${PORT}`);

  handleShutdown(server);
}

main().catch(fatal);
