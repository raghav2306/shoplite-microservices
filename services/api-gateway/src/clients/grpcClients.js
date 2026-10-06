const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const path = require("path");
const { service: healthService } = require("grpc-health-check");

const PROTO_DIR = path.join(__dirname, "../../../../proto");

function loadClient(protoFile, packageName, serviceName, address) {
  const packageDef = protoLoader.loadSync(path.join(PROTO_DIR, protoFile), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDef)[packageName];
  return new proto[serviceName](address, grpc.credentials.createInsecure());
}

const userClient = loadClient(
  "user.proto",
  "user",
  "UserService",
  process.env.USER_SERVICE_URL || "localhost:50051"
);

const productClient = loadClient(
  "product.proto",
  "product",
  "ProductService",
  process.env.PRODUCT_SERVICE_URL || "localhost:50052"
);

const orderClient = loadClient(
  "order.proto",
  "order",
  "OrderService",
  process.env.ORDER_SERVICE_URL || "localhost:50053"
);

const HealthClient = grpc.makeClientConstructor(healthService, "Health");

// grpc.health.v1 clients for readiness checks
const healthClient = (address) => new HealthClient(address, grpc.credentials.createInsecure());
const healthClients = {
  "user-service": healthClient(process.env.USER_SERVICE_URL || "localhost:50051"),
  "product-service": healthClient(process.env.PRODUCT_SERVICE_URL || "localhost:50052"),
  "order-service": healthClient(process.env.ORDER_SERVICE_URL || "localhost:50053"),
};

module.exports = { userClient, productClient, orderClient, healthClients };
