const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'school_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err);
});

async function testConnection() {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    console.log('PostgreSQL connected:', result.rows[0].now);
  } catch (err) {
    console.error('PostgreSQL connection failed:', err.message);
    throw err;
  }
}

/**
 * Execute a single query
 */
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV === 'development') {
    console.log('SQL:', { text: text.substring(0, 80), duration, rows: res.rowCount });
  }
  return res;
}

/**
 * Get a client for transactions
 */
async function getClient() {
  const client = await pool.connect();
  const originalQuery = client.query.bind(client);
  const release = client.release.bind(client);

  // Timeout: auto-release after 5s idle
  const timeout = setTimeout(() => {
    console.error('Client checkout timeout — forcibly releasing');
    client.release();
  }, 5000);

  client.release = () => {
    clearTimeout(timeout);
    release();
  };

  return client;
}

module.exports = { pool, query, getClient, testConnection };
