// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/feed-generators/generator-lifecycle.qnt
// Spec hash (sha256): 9842e0f3cdaf6c63af89d3fbf3772c70130d1e1ad7440f33f8a430469525c438
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const FeedGeneratorsGeneratorLifecycleFields = {
    status: Schema.String,
    version: Schema.BigInt,
    recordLive: Schema.Boolean,
    everPublished: Schema.Boolean,
    requests: Schema.BigInt,
    served: Schema.BigInt,
    rejected: Schema.BigInt
};
export const FeedGeneratorsGeneratorLifecycleStates = Machine.state({
    fields: FeedGeneratorsGeneratorLifecycleFields
});
export const FeedGeneratorsGeneratorLifecycleEvents = Machine.events({
    init: {},
    publish: {},
    update: {
        bump: Schema.BigInt
    },
    retire: {},
    restore: {},
    query: {}
});
export const FeedGeneratorsGeneratorLifecycleDefinition = Machine.make({
    id: "FeedGeneratorsGeneratorLifecycle",
    root: FeedGeneratorsGeneratorLifecycleStates,
    events: FeedGeneratorsGeneratorLifecycleEvents
});
export type FeedGeneratorsGeneratorLifecycleEvent = Machine.EventOf<typeof FeedGeneratorsGeneratorLifecycleEvents>;
