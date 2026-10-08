const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// معالج الأخطاء للاتصالات الخاملة
pool.on("error", (err) => {
  console.error("⚠ Unexpected error on idle Postgres client:", err.message);
});

module.exports = pool;
