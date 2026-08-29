const mysql = require('mysql2/promise');

let pool;

async function getPool() {
  if (pool) return pool;

  pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'booking_agent',
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
  });

  return pool;
}

async function ensureDatabase() {
  const dbName = process.env.DB_NAME || 'booking_agent';
  const tempPool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    waitForConnections: true,
    connectionLimit: 2,
    charset: 'utf8mb4',
  });

  try {
    await tempPool.execute(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`
    );
  } finally {
    await tempPool.end();
  }
}

async function initDb() {
  const maxRetries = 10;
  const retryDelay = 3000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await ensureDatabase();

      const p = await getPool();
      await p.execute(`
        CREATE TABLE IF NOT EXISTS appointments (
          id INT AUTO_INCREMENT PRIMARY KEY,
          caller_number VARCHAR(50),
          customer_name VARCHAR(255),
          service VARCHAR(255),
          requested_time VARCHAR(255),
          status VARCHAR(50) DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      await p.execute(`
        CREATE TABLE IF NOT EXISTS calls (
          id INT AUTO_INCREMENT PRIMARY KEY,
          call_sid VARCHAR(100),
          caller_number VARCHAR(50),
          transcript TEXT,
          outcome VARCHAR(100),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      console.log('Datenbank-Tabellen bereit.');
      return;
    } catch (err) {
      if (attempt < maxRetries) {
        console.log(`MySQL nicht bereit (Versuch ${attempt}/${maxRetries}), warte ${retryDelay / 1000}s...`);
        await new Promise((r) => setTimeout(r, retryDelay));
        pool = null;
      } else {
        throw new Error(`MySQL nach ${maxRetries} Versuchen nicht erreichbar: ${err.message}`);
      }
    }
  }
}

async function createAppointment({ caller_number, customer_name, service, requested_time }) {
  const p = await getPool();
  const [result] = await p.execute(
    'INSERT INTO appointments (caller_number, customer_name, service, requested_time, status) VALUES (?, ?, ?, ?, ?)',
    [caller_number, customer_name, service, requested_time, 'pending']
  );
  return result.insertId;
}

async function listAppointments() {
  const p = await getPool();
  const [rows] = await p.execute('SELECT * FROM appointments ORDER BY created_at DESC');
  return rows;
}

async function logCall({ call_sid, caller_number, transcript, outcome }) {
  const p = await getPool();
  await p.execute(
    'INSERT INTO calls (call_sid, caller_number, transcript, outcome) VALUES (?, ?, ?, ?)',
    [call_sid, caller_number, transcript, outcome]
  );
}

module.exports = { initDb, createAppointment, listAppointments, logCall };
