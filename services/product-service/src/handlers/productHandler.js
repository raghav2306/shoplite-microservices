const mongoose = require("mongoose");
const Product = require("../models/Product");

const NOT_FOUND = 5;
const FAILED_PRECONDITION = 9;
const INVALID_ARGUMENT = 3;
const INTERNAL = 13;

function grpcError(code, message) {
  return Object.assign(new Error(message), { code });
}

function toGrpcError(err) {
  return Number.isInteger(err.code) && err.code < 17
    ? err
    : { code: INTERNAL, message: "Internal error" };
}

function assertValidItem({ productId, quantity }) {
  if (!mongoose.isValidObjectId(productId)) {
    throw grpcError(NOT_FOUND, `Product ${productId} not found`);
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw grpcError(INVALID_ARGUMENT, `Invalid quantity for product ${productId}`);
  }
}

function toResponse(product) {
  return {
    id: product._id.toString(),
    name: product.name,
    description: product.description,
    price: product.price,
    stock: product.stock,
  };
}

function assertValidProduct({ name, price, stock }) {
  if (!name?.trim()) throw grpcError(INVALID_ARGUMENT, "Name is required");
  if (!(price >= 0)) throw grpcError(INVALID_ARGUMENT, "Price must be 0 or more");
  if (!Number.isInteger(stock) || stock < 0) {
    throw grpcError(INVALID_ARGUMENT, "Stock must be a whole number, 0 or more");
  }
}

async function CreateProduct(call, callback) {
  try {
    assertValidProduct(call.request);
    const { name, description, price, stock } = call.request;
    const product = await Product.create({ name, description, price, stock });
    callback(null, {
      id: product._id.toString(),
      name: product.name,
      price: product.price,
      stock: product.stock,
    });
  } catch (err) {
    callback(toGrpcError(err));
  }
}

async function UpdateProduct(call, callback) {
  try {
    const { productId, name, description, price, stock } = call.request;
    if (!mongoose.isValidObjectId(productId)) {
      return callback({ code: NOT_FOUND, message: "Product not found" });
    }
    assertValidProduct(call.request);
    const product = await Product.findByIdAndUpdate(
      productId,
      { name, description, price, stock },
      { new: true, runValidators: true }
    );
    if (!product) return callback({ code: NOT_FOUND, message: "Product not found" });
    callback(null, toResponse(product));
  } catch (err) {
    callback(toGrpcError(err));
  }
}

async function DeleteProduct(call, callback) {
  try {
    const { productId } = call.request;
    if (!mongoose.isValidObjectId(productId)) {
      return callback({ code: NOT_FOUND, message: "Product not found" });
    }
    const product = await Product.findByIdAndDelete(productId);
    if (!product) return callback({ code: NOT_FOUND, message: "Product not found" });
    callback(null, { success: true });
  } catch (err) {
    callback(toGrpcError(err));
  }
}

async function GetProduct(call, callback) {
  try {
    if (!mongoose.isValidObjectId(call.request.productId)) {
      return callback({ code: NOT_FOUND, message: "Product not found" });
    }
    const product = await Product.findById(call.request.productId);
    if (!product) return callback({ code: NOT_FOUND, message: "Product not found" });
    callback(null, {
      id: product._id.toString(),
      name: product.name,
      description: product.description,
      price: product.price,
      stock: product.stock,
    });
  } catch (err) {
    callback({ code: 13, message: err.message });
  }
}

async function ListProducts(call, callback) {
  try {
    const products = await Product.find();
    callback(null, {
      products: products.map((p) => ({
        id: p._id.toString(),
        name: p.name,
        description: p.description,
        price: p.price,
        stock: p.stock,
      })),
    });
  } catch (err) {
    callback({ code: 13, message: err.message });
  }
}

async function CheckStock(call, callback) {
  try {
    const { productId, quantity } = call.request;
    if (!mongoose.isValidObjectId(productId)) {
      return callback({ code: NOT_FOUND, message: "Product not found" });
    }
    const product = await Product.findById(productId);
    if (!product) return callback({ code: NOT_FOUND, message: "Product not found" });
    callback(null, {
      available: product.stock >= quantity,
      currentStock: product.stock,
    });
  } catch (err) {
    callback({ code: 13, message: err.message });
  }
}

async function DecrementStock(call, callback) {
  try {
    assertValidItem(call.request);
    const { productId, quantity } = call.request;
    // Conditional update so concurrent callers can't take stock below zero.
    const product = await Product.findOneAndUpdate(
      { _id: productId, stock: { $gte: quantity } },
      { $inc: { stock: -quantity } },
      { new: true }
    );
    if (!product) return callback({ code: FAILED_PRECONDITION, message: "Insufficient stock" });
    callback(null, { success: true, remainingStock: product.stock });
  } catch (err) {
    callback(toGrpcError(err));
  }
}

async function releaseItems(items) {
  for (const { productId, quantity } of items) {
    await Product.updateOne({ _id: productId }, { $inc: { stock: quantity } });
  }
}

async function ReserveStock(call, callback) {
  const reserved = [];
  try {
    const { items } = call.request;
    if (!items.length) throw grpcError(INVALID_ARGUMENT, "No items to reserve");
    items.forEach(assertValidItem);

    for (const { productId, quantity } of items) {
      const product = await Product.findOneAndUpdate(
        { _id: productId, stock: { $gte: quantity } },
        { $inc: { stock: -quantity } },
        { new: true }
      );
      if (!product) {
        const exists = await Product.exists({ _id: productId });
        throw exists
          ? grpcError(FAILED_PRECONDITION, `Insufficient stock for product ${productId}`)
          : grpcError(NOT_FOUND, `Product ${productId} not found`);
      }
      reserved.push({ productId, quantity, price: product.price });
    }

    callback(null, { items: reserved });
  } catch (err) {
    // All or nothing: give back whatever was taken before the failure.
    await releaseItems(reserved).catch((e) =>
      console.error("Failed to roll back partial reservation:", e.message, reserved)
    );
    callback(toGrpcError(err));
  }
}

async function ReleaseStock(call, callback) {
  try {
    const { items } = call.request;
    items.forEach(assertValidItem);
    await releaseItems(items);
    callback(null, { success: true });
  } catch (err) {
    callback(toGrpcError(err));
  }
}

module.exports = {
  CreateProduct,
  UpdateProduct,
  DeleteProduct,
  GetProduct,
  ListProducts,
  CheckStock,
  DecrementStock,
  ReserveStock,
  ReleaseStock,
};
