// Usage: node src/scripts/promoteAdmin.js <email>
// e.g.   docker compose exec user-service node src/scripts/promoteAdmin.js admin@example.com
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error("Usage: node src/scripts/promoteAdmin.js <email>");

  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/users");
  const user = await User.findOneAndUpdate({ email }, { role: "admin" }, { new: true });
  if (!user) throw new Error(`No user with email ${email}`);
  console.log(`${user.email} is now an admin (log in again to get a token with the new role)`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
