// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/space-host/grant-lifecycle.qnt
// Spec hash (sha256): 47396fb58760838ce4a9aeccef3cef4228b112a6bf54d69d6afdf5ea4ab8356d
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const GrantLifecycleFields = {
    grant: Schema.String,
    logHead: Schema.BigInt,
    expected: Schema.BigInt,
    outcome: Schema.String
};
export const GrantLifecycleStates = Machine.state({
    fields: GrantLifecycleFields
});
export const GrantLifecycleEvents = Machine.events({
    init: {},
    issue: {},
    use: {
        fresh: Schema.Boolean
    },
    revoke: {}
});
export const GrantLifecycleDefinition = Machine.make({
    id: "GrantLifecycle",
    root: GrantLifecycleStates,
    events: GrantLifecycleEvents
});
export type GrantLifecycleEvent = Machine.EventOf<typeof GrantLifecycleEvents>;
