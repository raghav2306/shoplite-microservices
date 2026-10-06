const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const path = require("path");

const PROTO_PATH = path.join(__dirname, "../../../../proto/product.proto");
const DEADLINE_MS = 5000;

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const productProto = grpc.loadPackageDefinition(packageDef).product;

const client = new productProto.ProductService(
  process.env.PRODUCT_SERVICE_URL || "localhost:50052",
  grpc.credentials.createInsecure()
);

function call(method, request) {
  return new Promise((resolve, reject) => {
    client[method](request, { deadline: Date.now() + DEADLINE_MS }, (err, res) =>
      err ? reject(err) : resolve(res)
    );
  });
}

const reserveStock = (items) => call("ReserveStock", { items });
const releaseStock = (items) => call("ReleaseStock", { items });

module.exports = { reserveStock, releaseStock };
