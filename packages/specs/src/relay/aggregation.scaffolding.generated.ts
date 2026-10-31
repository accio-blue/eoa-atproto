// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/relay/aggregation.qnt
// Spec hash (sha256): 2ebe46a1cda56762443fb5146bf3e793c618c6d721065f82ea454af2e56f6402
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const RelayAggregationFields = {
    status: Schema.String,
    feedSeq: Schema.BigInt,
    ackSeq: Schema.BigInt,
    backfillTarget: Schema.BigInt
};
export const RelayAggregationStates = Machine.state({
    fields: RelayAggregationFields
});
export const RelayAggregationEvents = Machine.events({
    init: {},
    goLive: {},
    appendBatch: {
        n: Schema.BigInt
    },
    ack: {
        n: Schema.BigInt
    },
    startBackfill: {
        from: Schema.BigInt
    },
    backfillAck: {
        n: Schema.BigInt
    }
});
export const RelayAggregationDefinition = Machine.make({
    id: "RelayAggregation",
    root: RelayAggregationStates,
    events: RelayAggregationEvents
});
export type RelayAggregationEvent = Machine.EventOf<typeof RelayAggregationEvents>;
