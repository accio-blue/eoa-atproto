// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/plugin-host/registry_gate.qnt
// Spec hash (sha256): 6b1a6f212e5683b73d127951c2132950f5cc8f3ddb34fdfdb92124c7ec309448
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const RegistryGateFields = {
    stage: Schema.String,
    signature: Schema.String,
    width: Schema.String
};
export const RegistryGateStates = Machine.state({
    fields: RegistryGateFields
});
export const RegistryGateEvents = Machine.events({
    init: {},
    submit: {
        scope: Schema.String
    },
    attest: {
        sig: Schema.String
    },
    publish: {},
    approve: {},
    reject: {}
});
export const RegistryGateDefinition = Machine.make({
    id: "RegistryGate",
    root: RegistryGateStates,
    events: RegistryGateEvents
});
export type RegistryGateEvent = Machine.EventOf<typeof RegistryGateEvents>;
