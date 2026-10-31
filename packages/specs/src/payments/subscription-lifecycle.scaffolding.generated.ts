// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/payments/subscription-lifecycle.qnt
// Spec hash (sha256): 94f4b2e06312de7e6607ae825e95919e973a4fe7300ef1f203fa4bc54f9118cb
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const PaymentsSubscriptionLifecycleFields = {
    state: Schema.String,
    paid: Schema.Boolean,
    failedRenewals: Schema.BigInt
};
export const PaymentsSubscriptionLifecycleStates = Machine.state({
    fields: PaymentsSubscriptionLifecycleFields
});
export const PaymentsSubscriptionLifecycleEvents = Machine.events({
    init: {},
    beginIntent: {},
    settleIntent: {
        cleared: Schema.Boolean
    },
    renew: {
        cleared: Schema.Boolean
    },
    retryRenewal: {
        cleared: Schema.Boolean
    },
    cancel: {}
});
export const PaymentsSubscriptionLifecycleDefinition = Machine.make({
    id: "PaymentsSubscriptionLifecycle",
    root: PaymentsSubscriptionLifecycleStates,
    events: PaymentsSubscriptionLifecycleEvents
});
export type PaymentsSubscriptionLifecycleEvent = Machine.EventOf<typeof PaymentsSubscriptionLifecycleEvents>;
