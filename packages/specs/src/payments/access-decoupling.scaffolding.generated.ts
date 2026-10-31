// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/payments/access-decoupling.qnt
// Spec hash (sha256): 5b0814020c6eb45f7fa1027d71ee80a233d10126f408712e71c40bea1b7cc2ea
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const PaymentsAccessDecouplingFields = {
    billing: Schema.String,
    accessGrant: Schema.Boolean,
    accessDecision: Schema.String
};
export const PaymentsAccessDecouplingStates = Machine.state({
    fields: PaymentsAccessDecouplingFields
});
export const PaymentsAccessDecouplingEvents = Machine.events({
    init: {},
    setBilling: {
        value: Schema.String
    },
    setAccessGrant: {
        granted: Schema.Boolean
    },
    evaluateAccess: {}
});
export const PaymentsAccessDecouplingDefinition = Machine.make({
    id: "PaymentsAccessDecoupling",
    root: PaymentsAccessDecouplingStates,
    events: PaymentsAccessDecouplingEvents
});
export type PaymentsAccessDecouplingEvent = Machine.EventOf<typeof PaymentsAccessDecouplingEvents>;
