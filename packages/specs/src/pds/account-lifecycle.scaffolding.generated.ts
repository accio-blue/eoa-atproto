// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/pds/account-lifecycle.qnt
// Spec hash (sha256): eb9cf170a870ae7c115e837b6a812a19d0db08c09302a4e4d976ffe0de1d6c23
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const PdsAccountLifecycleFields = {
    status: Schema.String,
    handleReserved: Schema.Boolean
};
export const PdsAccountLifecycleStates = Machine.state({
    fields: PdsAccountLifecycleFields
});
export const PdsAccountLifecycleEvents = Machine.events({
    init: {},
    create: {
        availability: Schema.String
    },
    activate: {},
    suspend: {},
    reinstate: {},
    deleteAccount: {}
});
export const PdsAccountLifecycleDefinition = Machine.make({
    id: "PdsAccountLifecycle",
    root: PdsAccountLifecycleStates,
    events: PdsAccountLifecycleEvents
});
export type PdsAccountLifecycleEvent = Machine.EventOf<typeof PdsAccountLifecycleEvents>;
