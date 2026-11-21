# surprise4u website and local backend

## Run the local website

1. Install Node.js.
2. Optionally copy `.env.example` to `.env` and add Razorpay **test-mode** Key ID and Key Secret.
3. In PowerShell, run `npm.cmd start` from this project folder. (`npm start` also works in shells that allow npm scripts.)
4. Open http://127.0.0.1:3000.

The server intentionally listens only on `127.0.0.1` for local development. The site is not public and its address cannot be submitted as a live website URL.

## Site pages

- `/index.html` — storefront, gift catalog, cart, gift order form, event enquiry.
- `/terms.html`, `/privacy.html`, `/refunds.html`, `/shipping.html`, `/contact.html` — policy and contact drafts.

The policy drafts contain `[ADD ... BEFORE LAUNCH]` placeholders. Replace them with the real business contact details, service area, delivery terms, cancellation cut-off, refund timeline and claims process before publishing or submitting the site for merchant review.

## Payment integration

- `GET /api/products` returns the server catalog.
- `POST /api/orders` creates a gift order or event enquiry. The server calculates catalog prices; it does not trust browser totals.
- `POST /api/payments/create-order` creates the Razorpay order on the server.
- Razorpay Standard Checkout shows payment methods enabled for the merchant account, such as UPI and cards.
- `POST /api/payments/verify` validates the checkout signature and confirms the payment against Razorpay's API.
- `GET /api/payment-config` reports whether the local server has gateway keys configured.

Copy `.env.example` to `.env` to configure local **test** keys. Never put `RAZORPAY_KEY_SECRET` in HTML, browser JavaScript, or source control. Test mode does not move real money; Live mode uses separate keys and requires account activation and website review.

## Work still required before launch

The legal/contact pages need the real details described above. The current server is local-only and stores order data in local JSON Lines files; those files may contain addresses and phone numbers. This prototype must not be exposed publicly. A production launch still needs a production hosting setup, database with access controls and backups, HTTPS, admin authentication, rate limiting, webhook/reconciliation handling, retention/deletion rules, and the merchant's approved live keys. Confirm payment is captured before fulfilling an order.
