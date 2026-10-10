/**
 * CUROSTA - Database Migration Runner
 *
 * التشغيل:
 * npm run migrate
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("../db");

const colors = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

async function runMigrations() {
  console.log(
    `\n${colors.bold}${colors.cyan}🚀 CUROSTA Migration Runner Starting...${colors.reset}\n`,
  );

  const client = await pool.connect();

  try {
    // 1. إنشاء جدول تتبع الـ migrations لو مش موجود
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. فحص هل الـ Baseline مسجل
    const appliedRes = await client.query("SELECT name FROM schema_migrations");
    const appliedMigrations = new Set(appliedRes.rows.map((r) => r.name));

    // إذا كانت الجداول الأساسية موجودة والـ baseline مش متسجل، نسجله كـ Applied لتجنب تكرار الإنشاء
    if (!appliedMigrations.has("001_baseline.sql")) {
      const tableCheck = await client.query(`
        SELECT to_regclass('public.users') AS users_table;
      `);
      if (tableCheck.rows[0].users_table) {
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ('001_baseline.sql') ON CONFLICT DO NOTHING;",
        );
        appliedMigrations.add("001_baseline.sql");
        console.log(
          `${colors.yellow}  ℹ Baseline schema (001_baseline.sql) marked as already applied.${colors.reset}`,
        );
      }
    }

    // 3. قراءة كل ملفات الـ SQL في فولدر migrations بالترتيب
    const migrationsDir = path.join(__dirname);
    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    let executedCount = 0;

    for (const file of files) {
      if (appliedMigrations.has(file)) {
        continue;
      }

      console.log(`  Applying: ${colors.bold}${file}${colors.reset}...`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, "utf-8");

      try {
        await client.query("BEGIN");
        // تشغيل كود المايجريشن
        await client.query(sql);
        // تسجيل اسم الملف في جدول المايجريشنز
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          file,
        ]);
        await client.query("COMMIT");

        console.log(
          `${colors.green}  ✔ [SUCCESS] ${file} applied successfully.${colors.reset}`,
        );
        executedCount++;
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(
          `${colors.red}  ✖ [FAILED] Migration ${file} failed: ${err.message}${colors.reset}\n`,
        );
        throw err;
      }
    }

    if (executedCount === 0) {
      console.log(
        `${colors.green}✨ Database is already up to date! No pending migrations.${colors.reset}\n`,
      );
    } else {
      console.log(
        `\n${colors.bold}${colors.green}🎉 Successfully applied ${executedCount} migration(s).${colors.reset}\n`,
      );
    }
  } catch (error) {
    console.error(
      `${colors.red}Migration runner aborted:${colors.reset}`,
      error.message,
    );
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
