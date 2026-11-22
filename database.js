const { Pool } = require('pg');

let pool;

function getPool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for production order storage.');
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DATABASE_POOL_SIZE || 5),
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    });
    pool.on('error', (error) => console.error('Database pool error:', error.message));
  }
  return pool;
}

async function initializeDatabase() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('gift', 'event')),
      status TEXT NOT NULL,
      payment_status TEXT NOT NULL,
      payment_method TEXT,
      details JSONB NOT NULL,
      items JSONB NOT NULL,
      total INTEGER NOT NULL CHECK (total >= 0),
      currency TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_attempts (
      gateway_order_id TEXT PRIMARY KEY,
      internal_order_id TEXT NOT NULL REFERENCES orders(id),
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_events (
      payment_id TEXT PRIMARY KEY,
      gateway_order_id TEXT NOT NULL,
      internal_order_id TEXT NOT NULL REFERENCES orders(id),
      payment_status TEXT NOT NULL,
      source TEXT NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS payment_attempts_internal_order_idx ON payment_attempts(internal_order_id);
    CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at);
  `);
}

async function createOrder(order) {
  const db = getPool();
  await db.query(
    `INSERT INTO orders (id, type, status, payment_status, payment_method, details, items, total, currency, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [order.id, order.type, order.status, order.paymentStatus, order.paymentMethod, order.details, order.items, order.total, order.currency, order.createdAt],
  );
}

async function getOrder(orderId) {
  const db = getPool();
  const result = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    paymentStatus: row.payment_status,
    paymentMethod: row.payment_method,
    details: row.details,
    items: row.items,
    total: row.total,
    currency: row.currency,
    createdAt: row.created_at,
  };
}

async function createPaymentAttempt(attempt) {
  const db = getPool();
  await db.query(
    `INSERT INTO payment_attempts (gateway_order_id, internal_order_id, amount, currency, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [attempt.gatewayOrderId, attempt.internalOrderId, attempt.amount, attempt.currency, attempt.createdAt],
  );
}

async function getPaymentAttempt(gatewayOrderId, internalOrderId) {
  const db = getPool();
  const result = await db.query(
    'SELECT * FROM payment_attempts WHERE gateway_order_id = $1 AND internal_order_id = $2',
    [gatewayOrderId, internalOrderId],
  );
  const row = result.rows[0];
  return row ? {
    gatewayOrderId: row.gateway_order_id,
    internalOrderId: row.internal_order_id,
    amount: row.amount,
    currency: row.currency,
    createdAt: row.created_at,
  } : null;
}

async function getPaymentAttemptByGatewayOrder(gatewayOrderId) {
  const db = getPool();
  const result = await db.query('SELECT * FROM payment_attempts WHERE gateway_order_id = $1', [gatewayOrderId]);
  const row = result.rows[0];
  return row ? {
    gatewayOrderId: row.gateway_order_id,
    internalOrderId: row.internal_order_id,
    amount: row.amount,
    currency: row.currency,
    createdAt: row.created_at,
  } : null;
}

async function recordPayment({ paymentId, gatewayOrderId, internalOrderId, paymentStatus, source }) {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO payment_events (payment_id, gateway_order_id, internal_order_id, payment_status, source, recorded_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (payment_id) DO UPDATE
       SET payment_status = EXCLUDED.payment_status, source = EXCLUDED.source, recorded_at = NOW()
       WHERE payment_events.payment_status <> 'captured' OR EXCLUDED.payment_status = 'captured'`,
      [paymentId, gatewayOrderId, internalOrderId, paymentStatus, source],
    );
    if (paymentStatus === 'captured') {
      await client.query(
        `UPDATE orders SET status = 'paid', payment_status = 'captured'
         WHERE id = $1 AND type = 'gift'`,
        [internalOrderId],
      );
    } else {
      await client.query(
        `UPDATE orders SET payment_status = $2
         WHERE id = $1 AND type = 'gift' AND payment_status <> 'captured'`,
        [internalOrderId, paymentStatus],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function checkDatabase() {
  await getPool().query('SELECT 1');
}

async function closeDatabase() {
  if (pool) await pool.end();
}

module.exports = {
  initializeDatabase,
  checkDatabase,
  createOrder,
  getOrder,
  createPaymentAttempt,
  getPaymentAttempt,
  getPaymentAttemptByGatewayOrder,
  recordPayment,
  closeDatabase,
};
