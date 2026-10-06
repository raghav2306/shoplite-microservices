const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/User");

const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

async function Register(call, callback) {
  try {
    const { name, email, password } = call.request;
    const existing = await User.findOne({ email });
    if (existing) return callback({ code: 6, message: "Email already registered" });

    const user = await User.create({ name, email, password });
    callback(null, { id: user._id.toString(), name: user.name, email: user.email });
  } catch (err) {
    callback({ code: 13, message: err.message });
  }
}

async function Login(call, callback) {
  try {
    const { email, password } = call.request;
    const user = await User.findOne({ email });
    if (!user) return callback({ code: 5, message: "Invalid credentials" });

    const valid = await user.comparePassword(password);
    if (!valid) return callback({ code: 5, message: "Invalid credentials" });

    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email, role: user.role },
      JWT_SECRET,
      {
        expiresIn: JWT_EXPIRES_IN,
      }
    );

    callback(null, { token, userId: user._id.toString() });
  } catch (err) {
    callback({ code: 13, message: err.message });
  }
}

function ValidateToken(call, callback) {
  try {
    const { token } = call.request;
    const decoded = jwt.verify(token, JWT_SECRET);
    callback(null, {
      valid: true,
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role || "user",
    });
  } catch {
    callback(null, { valid: false, userId: "", email: "", role: "" });
  }
}

async function GetUser(call, callback) {
  try {
    if (!mongoose.isValidObjectId(call.request.userId)) {
      return callback({ code: 5, message: "User not found" });
    }
    const user = await User.findById(call.request.userId);
    if (!user) return callback({ code: 5, message: "User not found" });
    callback(null, { id: user._id.toString(), name: user.name, email: user.email, role: user.role });
  } catch (err) {
    callback({ code: 13, message: err.message });
  }
}

module.exports = { Register, Login, ValidateToken, GetUser };
