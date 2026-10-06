require("dotenv").config();
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const mongoose = require("mongoose");
const path = require("path");
const handlers = require("./handlers/productHandler");
const { health, trackMongo, bindServer, handleShutdown, fatal } = require("./lifecycle");

const PROTO_PATH = path.join(__dirname, "../../../proto/product.proto");

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const productProto = grpc.loadPackageDefinition(packageDef).product;

async function main() {
  trackMongo();
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/products");
  console.log("Connected to MongoDB");

  const server = new grpc.Server();
  server.addService(productProto.ProductService.service, handlers);
  health.addToServer(server);

  const PORT = process.env.GRPC_PORT || 50052;
  await bindServer(server, PORT);
  console.log(`Product Service gRPC running on port ${PORT}`);

  handleShutdown(server);
}

main().catch(fatal);
