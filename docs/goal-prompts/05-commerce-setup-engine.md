# Goal: Business Commerce Setup Engine

You are working in `/Users/m3-max/Documents/GitHub/callan`. Make "handle online commerce" real for the customer's business, not just Callan's own Stripe invoice.

Persistence rule: do not complete until the system can intake commerce needs, create a safe CommercePlan, feed it into the website brief, and prove multiple verticals in deterministic checks. If live Stripe/customer setup is unsafe or gated, build mock/sandbox/operator-checklist paths and keep going.

Verify first:
- Callan revenue: `server/paymentFlow.js`, `server/providers/stripe.js`.
- Hosting upsell: `server/hostingSubscription.js`.
- Growth offers: `server/growth/*`.
- Customer portal/build brief can be extended.

Mission: support practical small-business commerce: quote requests, deposits, service packages, menus/catalogs, memberships, booking/payment interest, and safe handoffs for tax/legal/refund/regulated issues.

Implement:
1. Commerce intake:
   - products/services/packages
   - prices/ranges
   - deposit vs full payment
   - booking requirements
   - refund/cancellation text supplied by customer
   - fulfillment/delivery/pickup notes
   - regulated/tax-sensitive flags
2. `CommercePlan` schema:
   - type: `quote_request`, `booking_deposit`, `service_checkout`, `product_catalog`, `menu_inquiry`, `subscription_membership`, `handoff_only`
   - Stripe/payment-link requirements
   - site components needed
   - customer copy
   - risk flags and human handoff boundary
3. Stripe integration boundary:
   - clearly separate Callan's $500 invoice from customer's commerce
   - mock/sandbox payment-link generation or operator setup checklist
   - no live customer-business commerce without explicit env gates
4. Build integration:
   - WebsiteBrief includes commerce CTA and sections
   - no fake checkout links
   - placeholders are honest and actionable
5. UI:
   - operator commerce panel
   - customer portal commerce intake
   - launch checklist commerce readiness
6. Reply handling:
   - classify commerce requests from email into supported setup vs handoff
7. Checks:
   - restaurant menu inquiry
   - barber booking deposit
   - plumber quote request
   - HVAC maintenance subscription interest
   - tax/legal/refund-policy handoff

Acceptance:
- `npm run check` passes.
- `npm run build` passes.
- Add `npm run check:commerce` or equivalent.
- Existing revenue/Stripe invoice checks still pass.
- Final answer separates Callan revenue from customer-business commerce.

North-star finish line: a business owner can describe how they make money, and Callan turns it into a truthful website commerce flow without inventing policies or overstepping Stripe/legal boundaries.
