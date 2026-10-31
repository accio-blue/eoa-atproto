// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/plugin-host/capability_gate.qnt
// Spec hash (sha256): 54aa4f9a18690b1f1741565fe78e041a791f82664821c56d67e9356d581c7b5f
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const CapabilityGateFields = {
    declaredRead: Schema.Boolean,
    declaredWrite: Schema.Boolean,
    requested: Schema.String,
    decision: Schema.String
};
export const CapabilityGateStates = Machine.state({
    fields: CapabilityGateFields
});
export const CapabilityGateEvents = Machine.events({
    init: {},
    declare: {
        cap: Schema.String
    },
    revoke: {
        cap: Schema.String
    },
    request: {
        cap: Schema.String
    }
});
export const CapabilityGateDefinition = Machine.make({
    id: "CapabilityGate",
    root: CapabilityGateStates,
    events: CapabilityGateEvents
});
export type CapabilityGateEvent = Machine.EventOf<typeof CapabilityGateEvents>;
