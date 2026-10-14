const { Pool } = require("pg");
require("dotenv").config();

const isServerless = !!(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  // 🔒 تقييد الاتصالات لكل حاوية Serverless لمنع انهيار قاعدة البيانات
  max: isServerless ? 3 : 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on("error", (err) => {
  console.error("⚠ Unexpected error on idle Postgres client:", err.message);
});

module.exports = pool;
