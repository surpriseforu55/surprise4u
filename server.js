const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const database = require('./database');
const { createCustomerReply, MAX_HISTORY_MESSAGES, MAX_MESSAGE_LENGTH } = require('./ai-agent');

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
let aiChatWindowStartedAt = Date.now();
let aiChatWindowRequestCount = 0;
const AI_CHAT_REQUESTS_PER_MINUTE = 20;
const gatewayReady = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const databaseReady = () => Boolean(process.env.DATABASE_URL);
const localOrdersEnabled = () => process.env.ALLOW_LOCAL_ORDERS === 'true';
const publicOrdersEnabled = () => process.env.PREVIEW_MODE !== 'true' && (databaseReady() || (process.env.NODE_ENV !== 'production' && localOrdersEnabled()));

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

async function readRawBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32_000) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const raw = await readRawBody(request);
  try {
    return JSON.parse(raw.toString('utf8') || '{}');
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
  const sourceDetails = input.details && typeof input.details === 'object' && !Array.isArray(input.details) ? input.details : {};
  const allowedFields = input.type === 'gift'
    ? ['recipient', 'phone', 'deliveryDate', 'deliveryTime', 'address', 'giftType', 'occasion', 'giftMessage', 'sender', 'surprise']
    : ['eventType', 'eventDate', 'eventCity', 'guestCount', 'contactName', 'contactPhone', 'eventNotes', 'services'];
  const details = {};
  for (const field of allowedFields) {
    if (typeof sourceDetails[field] === 'string') details[field] = sourceDetails[field].trim().slice(0, field === 'address' || field === 'eventNotes' ? 1000 : 300);
  }
  if (input.type === 'event' && Array.isArray(sourceDetails.services)) {
    details.services = sourceDetails.services.filter((service) => ['Venue', 'Decoration', 'Food', 'Gifts'].includes(service)).slice(0, 4);
  }
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
  const phone = input.type === 'gift' ? details.phone : details.contactPhone;
  if (!/^\\+?[0-9][0-9\\s-]{7,14}$/.test(phone)) throw new Error('Please provide a valid contact phone number.');

  const itemCounts = new Map();
  if (input.type === 'gift' && Array.isArray(input.items)) {
    for (const item of input.items) {
      if (!PRODUCT_BY_ID.has(item.id)) throw new Error('A selected gift is unavailable.');
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error('Gift quantity must be between 1 and 20.');
      const combinedQuantity = (itemCounts.get(item.id) || 0) + quantity;
      if (combinedQuantity > 20) throw new Error('Gift quantity must be between 1 and 20.');
      itemCounts.set(item.id, combinedQuantity);
    }
  }
  const items = [...itemCounts.entries()].map(([id, quantity]) => ({ ...PRODUCT_BY_ID.get(id), quantity, lineTotal: PRODUCT_BY_ID.get(id).price * quantity }));
  const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
  return {
    id: `S4U-${randomUUID().toUpperCase()}`,
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

  if (request.method === 'POST' && url.pathname === '/api/ai-chat') {
    let body;
    try { body = await readJson(request); }
    catch (error) { return sendJson(response, 400, { error: error.message }); }
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_HISTORY_MESSAGES || messages[0]?.role !== 'user' || messages[messages.length - 1]?.role !== 'user') {
      return sendJson(response, 400, { error: 'Please send a valid chat message.' });
    }
    const validMessages = messages.every((message, index) =>
      message && message.role === (index % 2 === 0 ? 'user' : 'assistant') && typeof message.content === 'string' &&
      message.content.trim().length > 0 && message.content.length <= MAX_MESSAGE_LENGTH);
    if (!validMessages) return sendJson(response, 400, { error: 'Chat messages must be under 1,000 characters.' });
    if (Date.now() - aiChatWindowStartedAt >= 60_000) {
      aiChatWindowStartedAt = Date.now();
      aiChatWindowRequestCount = 0;
    }
    if (aiChatWindowRequestCount >= AI_CHAT_REQUESTS_PER_MINUTE) {
      return sendJson(response, 429, { error: 'The assistant is busy right now. Please try again in a minute.' });
    }
    aiChatWindowRequestCount += 1;
    try {
      const reply = await createCustomerReply(messages);
      return sendJson(response, 200, { reply });
    } catch (error) {
      return sendJson(response, error.statusCode || 502, { error: error.message || 'The assistant could not reply.' });
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    if (databaseReady()) await database.checkDatabase();
    return sendJson(response, 200, { status: 'ok', service: 'surprise4u' });
  }
  if (request.method === 'GET' && url.pathname === '/api/products') return sendJson(response, 200, { products: PRODUCTS, currency: 'INR' });
  if (request.method === 'GET' && url.pathname === '/api/payment-config') {
    return sendJson(response, 200, { provider: 'razorpay', enabled: publicOrdersEnabled() && gatewayReady(), keyId: publicOrdersEnabled() && gatewayReady() ? process.env.RAZORPAY_KEY_ID : null });
  }
  if (request.method === 'GET' && url.pathname === '/api/runtime-config') {
    return sendJson(response, 200, {
      preview: process.env.PREVIEW_MODE === 'true',
      ordersEnabled: publicOrdersEnabled(),
      paymentsEnabled: publicOrdersEnabled() && gatewayReady(),
      storage: databaseReady() ? 'persistent' : 'local',
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/orders') {
    if (process.env.PREVIEW_MODE === 'true') return sendJson(response, 503, { error: 'Preview site only. Orders are disabled until production storage and support details are configured.' });
    let order;
    try { order = normalizeOrder(await readJson(request)); }
    catch (error) { return sendJson(response, 400, { error: error.message }); }
    if (!publicOrdersEnabled()) return sendJson(response, 503, { error: 'Order submission is not enabled yet. Please contact support directly.' });
    if (order.type === 'gift' && order.total > 0 && !gatewayReady()) return sendJson(response, 503, { error: 'Gift checkout is temporarily unavailable. Please contact support before submitting your details.' });
    if (databaseReady()) await database.createOrder(order);
    else if (localOrdersEnabled()) await appendJsonLine(ORDERS_FILE, order);
    else return sendJson(response, 503, { error: 'Order storage is not configured.' });
    return sendJson(response, 201, { orderId: order.id, status: order.status, paymentStatus: order.paymentStatus, total: order.total, currency: order.currency });
  }

  if (request.method === 'POST' && url.pathname === '/api/payments/create-order') {
    if (process.env.PREVIEW_MODE === 'true') return sendJson(response, 503, { error: 'Payment checkout is disabled on the preview site.' });
    if (!gatewayReady()) return sendJson(response, 503, { error: 'Razorpay is not configured. Add test API keys to the local .env file and restart the server.' });
    let body;
    try { body = await readJson(request); }
    catch (error) { return sendJson(response, 400, { error: error.message }); }
    const order = databaseReady()
      ? await database.getOrder(body.orderId)
      : (await readJsonLines(ORDERS_FILE)).find((candidate) => candidate.id === body.orderId && candidate.type === 'gift');
    if (!order) return sendJson(response, 404, { error: 'Gift order was not found.' });
    if (order.type !== 'gift') return sendJson(response, 400, { error: 'Only gift orders can use this checkout.' });
    if (order.paymentStatus === 'captured' || order.status === 'paid') return sendJson(response, 409, { error: 'This order has already been paid.' });
    if (!Number.isInteger(order.total) || order.total < 1) return sendJson(response, 400, { error: 'This custom request has no catalog price to charge yet.' });
    try {
      const gatewayOrder = await createRazorpayOrder(order);
      const attempt = { internalOrderId: order.id, gatewayOrderId: gatewayOrder.id, amount: gatewayOrder.amount, currency: gatewayOrder.currency, createdAt: new Date().toISOString() };
      if (databaseReady()) await database.createPaymentAttempt(attempt);
      else await appendJsonLine(PAYMENT_ATTEMPTS_FILE, attempt);
      return sendJson(response, 201, { keyId: process.env.RAZORPAY_KEY_ID, razorpayOrderId: gatewayOrder.id, amount: gatewayOrder.amount, currency: gatewayOrder.currency, internalOrderId: order.id });
    } catch (error) {
      console.error('Razorpay order creation failed:', error.message);
      return sendJson(response, 502, { error: 'Razorpay could not start checkout. Check the test keys and try again.' });
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/payments/webhook') {
    if (process.env.PREVIEW_MODE === 'true') return sendJson(response, 503, { error: 'Payment webhooks are disabled on the preview site.' });
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) return sendJson(response, 503, { error: 'Payment webhook is not configured.' });
    let raw;
    try { raw = await readRawBody(request); }
    catch (error) { return sendJson(response, 400, { error: error.message }); }
    const expected = createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    if (!signaturesMatch(expected, request.headers['x-razorpay-signature'])) return sendJson(response, 400, { error: 'Webhook signature verification failed.' });
    let event;
    try { event = JSON.parse(raw.toString('utf8')); }
    catch { return sendJson(response, 400, { error: 'Webhook body must be valid JSON.' }); }
    const payment = event.payload?.payment?.entity;
    if (!['payment.captured', 'payment.failed'].includes(event.event) || !payment?.id || !payment?.order_id) {
      return sendJson(response, 200, { received: true, ignored: true });
    }
    const attempt = databaseReady()
      ? await database.getPaymentAttemptByGatewayOrder(payment.order_id)
      : (await readJsonLines(PAYMENT_ATTEMPTS_FILE)).find((entry) => entry.gatewayOrderId === payment.order_id);
    if (!attempt || payment.amount !== attempt.amount || payment.currency !== attempt.currency) return sendJson(response, 400, { error: 'Payment does not match a recorded order.' });
    const paymentStatus = event.event === 'payment.captured' && payment.status === 'captured' ? 'captured' : payment.status;
    const result = { internalOrderId: attempt.internalOrderId, gatewayOrderId: payment.order_id, paymentId: payment.id, paymentStatus, verifiedAt: new Date().toISOString() };
    if (databaseReady()) await database.recordPayment({ ...result, source: 'webhook' });
    else await appendJsonLine(PAYMENT_EVENTS_FILE, result);
    return sendJson(response, 200, { received: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/payments/verify') {
    if (process.env.PREVIEW_MODE === 'true') return sendJson(response, 503, { error: 'Payment verification is disabled on the preview site.' });
    if (!gatewayReady()) return sendJson(response, 503, { error: 'Razorpay is not configured.' });
    let body;
    try { body = await readJson(request); }
    catch (error) { return sendJson(response, 400, { error: error.message }); }
    const attempt = databaseReady()
      ? await database.getPaymentAttempt(body.razorpay_order_id, body.internalOrderId)
      : (await readJsonLines(PAYMENT_ATTEMPTS_FILE)).find((entry) => entry.gatewayOrderId === body.razorpay_order_id && entry.internalOrderId === body.internalOrderId);
    if (!attempt) return sendJson(response, 400, { error: 'Payment order does not match this gift order.' });
    if (typeof body.razorpay_payment_id !== 'string' || !/^pay_[A-Za-z0-9]+$/.test(body.razorpay_payment_id)) return sendJson(response, 400, { error: 'Payment ID is invalid.' });
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
    if (databaseReady()) {
      await database.recordPayment({ ...result, source: 'checkout' });
    } else {
      await appendJsonLine(PAYMENT_EVENTS_FILE, result);
    }
    return sendJson(response, 200, { verified: true, orderId: attempt.internalOrderId, paymentId: payment.id, paymentStatus });
  }

  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(302, { Location: '/index.html' });
    return response.end();
  }
  const publicAssets = new Map([
    ['/ai-chat.js', 'text/javascript; charset=utf-8'],
    ['/ai-chat.css', 'text/css; charset=utf-8'],
  ]);
  if (request.method === 'GET' && publicAssets.has(url.pathname)) {
    const asset = await fs.readFile(path.join(ROOT, url.pathname.slice(1)));
    response.writeHead(200, { 'Content-Type': publicAssets.get(url.pathname), 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    return response.end(asset);
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
  if (process.env.NODE_ENV === 'production' && process.env.PREVIEW_MODE !== 'true') {
    if (!databaseReady()) throw new Error('Production startup blocked: DATABASE_URL is required.');
    if (!gatewayReady() || !process.env.RAZORPAY_KEY_ID.startsWith('rzp_live_')) throw new Error('Production startup blocked: configured Razorpay live credentials are required.');
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) throw new Error('Production startup blocked: RAZORPAY_WEBHOOK_SECRET is required.');
  }
  if (databaseReady()) await database.initializeDatabase();
  const server = http.createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (process.env.NODE_ENV === 'production') response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    handle(request, response).catch((error) => {
      console.error(error);
      if (!response.headersSent) sendJson(response, 500, { error: 'The server could not complete the request.' });
      else response.destroy();
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`surprise4u is running at http://${HOST}:${PORT}`);
    console.log(`Razorpay test checkout: ${gatewayReady() ? 'configured' : 'not configured; see .env.example'}`);
    console.log(databaseReady() ? 'Order storage: PostgreSQL' : 'Order storage: local JSON Lines (development only)');
  });
  const shutdown = () => server.close(async () => {
    await database.closeDatabase();
    process.exit(0);
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((error) => { console.error(error); process.exitCode = 1; });
