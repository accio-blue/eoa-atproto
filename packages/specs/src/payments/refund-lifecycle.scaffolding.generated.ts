// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/payments/refund-lifecycle.qnt
// Spec hash (sha256): dce2dc7faa41e7e9eecc77126f16da0bf550f78a6d07dfb3dbaa632846e26747
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const PaymentsRefundLifecycleFields = {
    stage: Schema.String,
    refunds: Schema.BigInt,
    chargeSettled: Schema.Boolean
};
export const PaymentsRefundLifecycleStates = Machine.state({
    fields: PaymentsRefundLifecycleFields
});
export const PaymentsRefundLifecycleEvents = Machine.events({
    init: {},
    settleCharge: {},
    requestRefund: {},
    processRefund: {
        cleared: Schema.Boolean
    },
    retryRefund: {
        cleared: Schema.Boolean
    }
});
export const PaymentsRefundLifecycleDefinition = Machine.make({
    id: "PaymentsRefundLifecycle",
    root: PaymentsRefundLifecycleStates,
    events: PaymentsRefundLifecycleEvents
});
export type PaymentsRefundLifecycleEvent = Machine.EventOf<typeof PaymentsRefundLifecycleEvents>;
