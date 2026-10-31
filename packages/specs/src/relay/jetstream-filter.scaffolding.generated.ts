// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/relay/jetstream-filter.qnt
// Spec hash (sha256): ec2e399acdce553dcc10db7dc7280e4179d1ec8584afaef680950730a57e7284
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const RelayJetstreamFilterFields = {
    status: Schema.String,
    seen: Schema.BigInt,
    matched: Schema.BigInt,
    dropped: Schema.BigInt
};
export const RelayJetstreamFilterStates = Machine.state({
    fields: RelayJetstreamFilterFields
});
export const RelayJetstreamFilterEvents = Machine.events({
    init: {},
    start: {},
    record: {
        collection: Schema.String
    },
    pause: {},
    resume: {},
    stop: {}
});
export const RelayJetstreamFilterDefinition = Machine.make({
    id: "RelayJetstreamFilter",
    root: RelayJetstreamFilterStates,
    events: RelayJetstreamFilterEvents
});
export type RelayJetstreamFilterEvent = Machine.EventOf<typeof RelayJetstreamFilterEvents>;
