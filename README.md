# surprise4u website and local backend

## Run locally

1. Install Node.js.
2. Run `npm install` to install the PostgreSQL client.
3. Optionally copy `.env.example` to `.env` and add Razorpay test-mode keys.
4. Keep `ALLOW_LOCAL_ORDERS=false` for a view-only preview. To test form submissions with sample data, set it to `true`; local requests are stored in files under `data/`.
5. In PowerShell run `npm.cmd start` from this folder.
6. Open http://127.0.0.1:3000.

## Preview deployment

`render.yaml` defines a read-only free preview service. `render.staging.yaml` defines a separate Singapore staging web service and a temporary free PostgreSQL database, with Razorpay test secrets requested during Blueprint setup. Push the project to a Git repository, then create a Render Blueprint using `render.staging.yaml`. Render supplies an `onrender.com` URL. The staging Blueprint is for payment testing only: Render's free Postgres expires after 30 days and has no automated logical backups. Use a paid, backed-up database and a separately configured service for production. Local runs remain bound to 127.0.0.1.

The free preview has an ephemeral filesystem. Orders saved to local JSON Lines files can disappear after a restart or deploy, so do not use it to collect real customer information or fulfill real orders. Razorpay credentials are intentionally not included in the Blueprint. Do not configure live keys in this preview.

## Website pages

- `/index.html` — gift catalog, cart, gift details, event inquiry.
- `/terms.html`, `/privacy.html`, `/refunds.html`, `/shipping.html`, `/contact.html` — policy drafts.

The policy pages include the business and Purnea delivery details supplied for this project. Review the draft terms and confirm operational details (including support hours, record retention, delivery charges, and event cancellation fees) before launch or merchant review.

## Orders and payments

Catalog prices are recalculated by the server. A production deployment requires PostgreSQL through `DATABASE_URL`, Razorpay live API credentials, and a separate `RAZORPAY_WEBHOOK_SECRET`. Startup refuses production mode if these are missing. The app stores orders and payment attempts in PostgreSQL, validates checkout signatures, checks payment details with Razorpay, accepts signed `payment.captured` and `payment.failed` webhooks at `/api/payments/webhook`, and marks an order paid only after capture.

For local testing, use Razorpay test keys and sample customer data only. `ALLOW_LOCAL_ORDERS=true` enables development-only JSONL storage; it is ignored in production. The free Render preview remains read-only with order/payment submission disabled.

## AI customer-support chat

The homepage chat assistant answers general questions about the supplied catalog, Purnea delivery area, and cancellation policies. It cannot access orders, accept payments, create bookings, or issue refunds. Messages and recent chat context are sent to the OpenAI Responses API to generate replies; the API key remains in server environment variables. Set `OPENAI_API_KEY` locally in `.env` or in Render's secret environment settings. Both Render Blueprint files request the key as a secret. `OPENAI_MODEL` defaults to `gpt-6.2-astra`. Without a key, the chat reports that it is not configured. OpenAI API usage may incur charges; configure a usage budget or limits in your OpenAI Platform account before publishing the chat. See [OpenAI's API quickstart](https://developers.openai.com/api/docs/quickstart) for API key creation and secure environment setup.

## Before accepting real customers

1. Choose and configure production hosting with HTTPS and a managed PostgreSQL database. Set `NODE_ENV=production`, `HOST=0.0.0.0`, and the database connection secret in the host's secret settings. Do not set `PREVIEW_MODE=true` for production.
2. Complete merchant onboarding and configure the approved Razorpay live Key ID and Key Secret as server secrets. Create a webhook with a separate secret pointing to `https://YOUR_DOMAIN/api/payments/webhook`; subscribe to `payment.captured` and `payment.failed`.
3. Configure automated database backups, least-privilege database access, monitoring, and a process for handling paid orders, cancellations, refunds, and customer support. The app does not yet include an operator dashboard, customer notifications, or automated fulfilment.
4. Confirm the policy details still marked for review in the Website pages section, test the complete flow using Razorpay test mode on the production-like host, and only then decide whether to enable live checkout.

Never fulfil an order based only on the browser callback; use the captured status recorded by the server.
