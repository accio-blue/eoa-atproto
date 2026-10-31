// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/blob-media/media-routing.qnt
// Spec hash (sha256): efc750d46347f9c7de32e91baedcd796c8fc208ca84175ba0f246bf6257e06b5
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const BlobMediaMediaRoutingFields = {
    phase: Schema.String,
    requested: Schema.String,
    availability: Schema.String,
    route: Schema.String,
    served: Schema.BigInt,
    redirected: Schema.BigInt,
    rejected: Schema.BigInt
};
export const BlobMediaMediaRoutingStates = Machine.state({
    fields: BlobMediaMediaRoutingFields
});
export const BlobMediaMediaRoutingEvents = Machine.events({
    init: {},
    accept: {
        pick: Schema.String
    },
    probe: {
        found: Schema.String
    },
    deliver: {},
    reset: {}
});
export const BlobMediaMediaRoutingDefinition = Machine.make({
    id: "BlobMediaMediaRouting",
    root: BlobMediaMediaRoutingStates,
    events: BlobMediaMediaRoutingEvents
});
export type BlobMediaMediaRoutingEvent = Machine.EventOf<typeof BlobMediaMediaRoutingEvents>;
