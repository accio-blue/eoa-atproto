// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/feed-generators/ranking-lens.qnt
// Spec hash (sha256): 7cf21457aacd6010469fdb06e57bacb63e989b1c22142015cd2ed894bcf36262
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const FeedGeneratorsRankingLensFields = {
    lens: Schema.String,
    observed: Schema.BigInt,
    blocked: Schema.BigInt,
    duplicate: Schema.BigInt,
    pending: Schema.BigInt,
    ranked: Schema.BigInt,
    suppressed: Schema.BigInt,
    slot: Schema.BigInt
};
export const FeedGeneratorsRankingLensStates = Machine.state({
    fields: FeedGeneratorsRankingLensFields
});
export const FeedGeneratorsRankingLensEvents = Machine.events({
    init: {},
    chooseLens: {
        choice: Schema.String
    },
    observe: {
        outcome: Schema.String
    },
    place: {
        decision: Schema.String
    }
});
export const FeedGeneratorsRankingLensDefinition = Machine.make({
    id: "FeedGeneratorsRankingLens",
    root: FeedGeneratorsRankingLensStates,
    events: FeedGeneratorsRankingLensEvents
});
export type FeedGeneratorsRankingLensEvent = Machine.EventOf<typeof FeedGeneratorsRankingLensEvents>;
