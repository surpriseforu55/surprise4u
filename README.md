# surprise4u website and local backend

## Run locally

1. Install Node.js.
2. Optionally copy `.env.example` to `.env` and add Razorpay test-mode keys.
3. In PowerShell run `npm.cmd start` from this folder.
4. Open http://127.0.0.1:3000.

## Preview deployment

`render.yaml` defines a free Render web service for preview. Add the latest project files to the public GitHub repository, then create a Blueprint in Render from that repository. Render supplies a temporary `onrender.com` URL. The preview service binds to Render's network interface only when Render sets `HOST=0.0.0.0`; local runs remain bound to 127.0.0.1.

The free preview has an ephemeral filesystem. Orders saved to local JSON Lines files can disappear after a restart or deploy, so do not use it to collect real customer information or fulfill real orders. Razorpay credentials are intentionally not included in the Blueprint. Do not configure live keys in this preview.

## Website pages

- `/index.html` — gift catalog, cart, gift details, event inquiry.
- `/terms.html`, `/privacy.html`, `/refunds.html`, `/shipping.html`, `/contact.html` — policy drafts.

These pages still contain `[ADD ... BEFORE LAUNCH]` placeholders. Replace them with accurate business contacts, service areas, delivery terms, refund/cancellation timelines and claims process before asking Razorpay to review the site.

## Payment flow

The Node backend calculates catalog prices and includes Razorpay order creation and signature/status verification. Razorpay Standard Checkout displays payment methods enabled for the merchant account, such as UPI and cards. Test and live keys are separate; the Key Secret must stay in server environment variables and never go in browser code or source control.

The free preview is not a production payment service. Before real payments, connect a durable database with access controls and backups, configure production hosting and HTTPS, complete security/privacy and webhook handling, and use the merchant account's approved live keys. Fulfil orders only after server-side payment status verification confirms capture.
