// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/directory/handle-resolution.qnt
// Spec hash (sha256): 150b6de483ef696cb0c46d694f73d57c026fa1c2193bc9333f28f15aad0dccb4
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const HandleResolutionFields = {
    phase: Schema.String,
    source: Schema.String,
    handle: Schema.String,
    dns: Schema.String,
    wellKnown: Schema.String,
    resolvedDid: Schema.String,
    docHandle: Schema.String
};
export const HandleResolutionStates = Machine.state({
    fields: HandleResolutionFields
});
export const HandleResolutionEvents = Machine.events({
    init: {},
    dnsLookup: {
        result: Schema.String
    },
    wellKnownLookup: {
        result: Schema.String
    },
    verify: {
        claim: Schema.String
    }
});
export const HandleResolutionDefinition = Machine.make({
    id: "HandleResolution",
    root: HandleResolutionStates,
    events: HandleResolutionEvents
});
export type HandleResolutionEvent = Machine.EventOf<typeof HandleResolutionEvents>;
