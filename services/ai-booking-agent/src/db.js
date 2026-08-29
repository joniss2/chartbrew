const mysql = require("mysql2/promise");

let pool;

const DB_NAME = process.env.DB_NAME || "booking_agent";

function poolConfig(database) {
  return {
    host: process.env.DB_HOST || "db",
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    charset: "utf8mb4",
  };
}

async function getPool() {
  if (!pool) {
    pool = mysql.createPool(poolConfig(DB_NAME));
  }
  return pool;
}

async function ensureDatabase() {
  const tmp = mysql.createPool(poolConfig(undefined));
  try {
    await tmp.execute(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`
    );
  } finally {
    await tmp.end();
  }
}

async function initDb(retries = 30, delay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const p = await getPool();
      await p.execute("SELECT 1");

      await p.execute(`
        CREATE TABLE IF NOT EXISTS appointments (
          id INT AUTO_INCREMENT PRIMARY KEY,
          caller_number VARCHAR(30) NOT NULL,
          customer_name VARCHAR(255) NOT NULL DEFAULT '',
          service VARCHAR(255) NOT NULL,
          requested_time DATETIME NOT NULL,
          status ENUM('pending','confirmed','cancelled') NOT NULL DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      await p.execute(`
        CREATE TABLE IF NOT EXISTS calls (
          id INT AUTO_INCREMENT PRIMARY KEY,
          call_sid VARCHAR(64) NOT NULL,
          caller_number VARCHAR(30) NOT NULL,
          transcript TEXT,
          outcome VARCHAR(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      console.log("Database initialized successfully");
      return;
    } catch (err) {
      if (err.code === "ER_BAD_DB_ERROR") {
        console.log(`Database '${DB_NAME}' does not exist, attempting to create it...`);
        try {
          await ensureDatabase();
          pool = null;
          continue;
        } catch (createErr) {
          console.log(`Could not create database (user may lack CREATE privilege): ${createErr.message}`);
        }
      }

      if (attempt < retries) {
        console.log(`DB not ready (attempt ${attempt}/${retries}): ${err.message}`);
        await new Promise((r) => setTimeout(r, delay));
        pool = null;
      } else {
        throw new Error(`Failed to connect to database after ${retries} attempts: ${err.message}`);
      }
    }
  }
}

async function createAppointment({ callerNumber, customerName, service, requestedTime }) {
  const p = await getPool();
  const [result] = await p.execute(
    `INSERT INTO appointments (caller_number, customer_name, service, requested_time)
     VALUES (?, ?, ?, ?)`,
    [callerNumber, customerName || "", service, requestedTime]
  );
  return { id: result.insertId };
}

async function listAppointments({ date, status } = {}) {
  const p = await getPool();
  let sql = "SELECT * FROM appointments WHERE 1=1";
  const params = [];

  if (date) {
    sql += " AND DATE(requested_time) = ?";
    params.push(date);
  }
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }

  sql += " ORDER BY requested_time ASC";
  const [rows] = await p.execute(sql, params);
  return rows;
}

async function logCall({ callSid, callerNumber, transcript, outcome }) {
  const p = await getPool();
  await p.execute(
    `INSERT INTO calls (call_sid, caller_number, transcript, outcome)
     VALUES (?, ?, ?, ?)`,
    [callSid, callerNumber, transcript || null, outcome || null]
  );
}

module.exports = { initDb, createAppointment, listAppointments, logCall };
