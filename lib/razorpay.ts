/**
 * Superseded by the multi-gateway payment layer.
 *
 * The Razorpay integration now lives in `lib/payments/razorpay.ts` as one
 * adapter behind the `Gateway` contract, and credentials come from the
 * `payment_gateways` table rather than from the environment alone. This
 * file is kept only as a signpost — nothing imports it, and it may be
 * deleted.
 *
 * @deprecated Import from `@/lib/payments` instead.
 */

export { razorpay, RAZORPAY_CHECKOUT_SCRIPT } from "./payments/razorpay";
