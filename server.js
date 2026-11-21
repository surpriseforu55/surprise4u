const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHmac, timingSafeEqual } = require('node:crypto');

async function loadLocalEnv() {
  try {
    const content = await fs.readFile(path.join(__dirname, '.env'), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && !match[1].startsWith('#') && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.jsonl');
const PAYMENT_ATTEMPTS_FILE = path.join(DATA_DIR, 'payment-attempts.jsonl');
const PAYMENT_EVENTS_FILE = path.join(DATA_DIR, 'payment-events.jsonl');
const PRODUCTS = [
  { id: 'mug', name: 'Personalized Mug', price: 499 },
  { id: 'frame', name: 'Custom Photo Frame', price: 799 },
  { id: 'hamper', name: 'Celebration Hamper', price: 1299 },
  { id: 'flowers', name: 'Flowers & Cake', price: 1499 },
];
const PRODUCT_BY_ID = new Map(PRODUCTS.map((product) => [product.id, product]));
const gatewayReady = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 32_000) throw new Error('Request is too large.');
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

async function readJsonLines(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function appendJsonLine(file, value) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function normalizeOrder(input) {
  if (!input || !['gift', 'event'].includes(input.type)) throw new Error('Choose a valid order type.');
  const details = input.details && typeof input.details === 'object' ? input.details : {};
  const paymentMethod = ['UPI QR', 'UPI app', 'Card'].includes(input.paymentMethod) ? input.paymentMethod : null;

  if (input.type === 'gift') {
    for (const field of ['recipient', 'phone', 'deliveryDate', 'deliveryTime', 'address']) {
      if (typeof details[field] !== 'string' || !details[field].trim()) throw new Error(`Please provide ${field}.`);
    }
  } else {
    for (const field of ['eventType', 'eventDate', 'eventCity', 'contactName', 'contactPhone']) {
      if (typeof details[field] !== 'string' || !details[field].trim()) throw new Error(`Please provide ${field}.`);
    }
  }

  const itemCounts = new Map();
  if (input.type === 'gift' && Array.isArray(input.items)) {
    for (const item of input.items) {
      if (!PRODUCT_BY_ID.has(item.id)) throw new Error('A selected gift is unavailable.');
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error('Gift quantity must be between 1 and 20.');
      itemCounts.set(item.id, (itemCounts.get(item.id) || 0) + quantity);
    }
  }
  const items = [...itemCounts.entries()].map(([id, quantity]) => ({ ...PRODUCT_BY_ID.get(id), quantity, lineTotal: PRODUCT_BY_ID.get(id).price * quantity }));
  const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
  return {
    id: `S4U-${randomUUID().slice(0, 8).toUpperCase()}`,
    type: input.type,
    status: input.type === 'gift' && total > 0 ? 'awaiting_payment' : 'received',
    paymentStatus: 'not_started',
    paymentMethod,
    details,
    items,
    total,
    currency: 'INR',
    createdAt: new Date().toISOString(),
  };
}

async function createRazorpayOrder(order) {
  const credentials = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const response = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: order.total * 100,
      currency: 'INR',
      receipt: order.id,
      notes: { surprise4u_order_id: order.id },
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.description || 'Razorpay could not create a payment order.');
  return result;
}

function signaturesMatch(expected, received) {
  if (typeof received !== 'string' || !/^[a-f0-9]{64}$/i.test(received)) return false;
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(received, 'hex');
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { status: 'ok', service: 'surprise4u' });
  if (request.method === 'GET' && url.pathname === '/api/products') return sendJson(response, 200, { products: PRODUCTS, currency: 'INR' });
  if (request.method === 'GET' && url.pathname === '/api/payment-config') {
    return sendJson(response, 200, { provider: 'razorpay', enabled: gatewayReady(), keyId: gatewayReady() ? process.env.RAZORPAY_KEY_ID : null });
  }

  if (request.method === 'POST' && url.pathname === '/api/orders') {
    if (process.env.PREVIEW_MODE === 'true') return sendJson(response, 503, { error: 'Preview site only. Orders are disabled until production storage and support details are configured.' });
    let order;
    try { order = normalizeOrder(await readJson(request)); }
    catch (error) { return sendJson(response, 400, { error: error.message }); }
    await appendJsonLine(ORDERS_FILE, order);
    return sendJson(response, 201, { orderId: order.id, status: order.status, paymentStatus: order.paymentStatus, total: order.total, currency: order.currency });
  }

  if (request.method === 'POST' && url.pathname === '/api/payments/create-order') {
    if (process.env.PREVIEW_MODE === 'true') return sendJson(response, 503, { error: 'Payment checkout is disabled on the preview site.' });
    if (!gatewayReady()) return sendJson(response, 503, { error: 'Razorpay is not configured. Add test API keys to the local .env file and restart the server.' });
    let body;
    try { body = await readJson(request); }
    catch (error) { return sendJson(response, 400, { error: error.message }); }
    const orders = await readJsonLines(ORDERS_FILE);
    const order = orders.find((candidate) => candidate.id === body.orderId && candidate.type === 'gift');
    if (!order) return sendJson(response, 404, { error: 'Gift order was not found.' });
    if (!Number.isInteger(order.total) || order.total < 1) return sendJson(response, 400, { error: 'This custom request has no catalog price to charge yet.' });
    try {
      const gatewayOrder = await createRazorpayOrder(order);
      await appendJsonLine(PAYMENT_ATTEMPTS_FILE, { internalOrderId: order.id, gatewayOrderId: gatewayOrder.id, amount: gatewayOrder.amount, currency: gatewayOrder.currency, createdAt: new Date().toISOString() });
      return sendJson(response, 201, { keyId: process.env.RAZORPAY_KEY_ID, razorpayOrderId: gatewayOrder.id, amount: gatewayOrder.amount, currency: gatewayOrder.currency, internalOrderId: order.id });
    } catch (error) {
      console.error('Razorpay order creation failed:', error.message);
      return sendJson(response, 502, { error: 'Razorpay could not start checkout. Check the test keys and try again.' });
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/payments/verify') {
    if (process.env.PREVIEW_MODE === 'true') return sendJson(response, 503, { error: 'Payment verification is disabled on the preview site.' });
    if (!gatewayReady()) return sendJson(response, 503, { error: 'Razorpay is not configured.' });
    let body;
    try { body = await readJson(request); }
    catch (error) { return sendJson(response, 400, { error: error.message }); }
    const attempts = await readJsonLines(PAYMENT_ATTEMPTS_FILE);
    const attempt = attempts.find((entry) => entry.gatewayOrderId === body.razorpay_order_id && entry.internalOrderId === body.internalOrderId);
    if (!attempt) return sendJson(response, 400, { error: 'Payment order does not match this gift order.' });
    const expected = createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${attempt.gatewayOrderId}|${body.razorpay_payment_id}`).digest('hex');
    if (!signaturesMatch(expected, body.razorpay_signature)) return sendJson(response, 400, { error: 'Payment signature verification failed.' });

    const credentials = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(body.razorpay_payment_id)}`, { headers: { Authorization: `Basic ${credentials}` } });
    const payment = await paymentResponse.json();
    if (!paymentResponse.ok || payment.order_id !== attempt.gatewayOrderId || payment.amount !== attempt.amount || payment.currency !== attempt.currency) {
      return sendJson(response, 400, { error: 'Razorpay payment details could not be verified.' });
    }
    const paymentStatus = payment.status === 'captured' ? 'captured' : payment.status;
    const result = { internalOrderId: attempt.internalOrderId, gatewayOrderId: payment.order_id, paymentId: payment.id, paymentStatus, verifiedAt: new Date().toISOString() };
    await appendJsonLine(PAYMENT_EVENTS_FILE, result);
    return sendJson(response, 200, { verified: true, orderId: attempt.internalOrderId, paymentId: payment.id, paymentStatus });
  }

  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(302, { Location: '/index.html' });
    return response.end();
  }
  const publicPages = new Set(['/index.html', '/terms.html', '/privacy.html', '/refunds.html', '/shipping.html', '/contact.html']);
  if (request.method === 'GET' && publicPages.has(url.pathname)) {
    const pageName = url.pathname.slice(1);
    const html = await fs.readFile(path.join(ROOT, pageName));
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    return response.end(html);
  }
  return sendJson(response, 404, { error: 'Not found.' });
}

async function start() {
  await loadLocalEnv();
  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      console.error(error);
      if (!response.headersSent) sendJson(response, 500, { error: 'The server could not complete the request.' });
      else response.destroy();
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`surprise4u is running at http://${HOST}:${PORT}`);
    console.log(`Razorpay test checkout: ${gatewayReady() ? 'configured' : 'not configured; see .env.example'}`);
    console.log('Local order records: data/orders.jsonl');
  });
}

start().catch((error) => { console.error(error); process.exitCode = 1; });
