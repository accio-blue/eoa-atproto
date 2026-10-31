// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/feed-generators/feed-query-cursor.qnt
// Spec hash (sha256): 1d3b589f05482ccf32ad43f429751228fad59c88328a248853adc7b8bda5927c
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const FeedGeneratorsFeedQueryCursorFields = {
    status: Schema.String,
    fetched: Schema.BigInt,
    served: Schema.BigInt,
    deduped: Schema.BigInt,
    cursor: Schema.BigInt,
    pages: Schema.BigInt
};
export const FeedGeneratorsFeedQueryCursorStates = Machine.state({
    fields: FeedGeneratorsFeedQueryCursorFields
});
export const FeedGeneratorsFeedQueryCursorEvents = Machine.events({
    init: {},
    open: {},
    page: {
        fresh: Schema.BigInt
    },
    replay: {
        stale: Schema.BigInt
    },
    reset: {}
});
export const FeedGeneratorsFeedQueryCursorDefinition = Machine.make({
    id: "FeedGeneratorsFeedQueryCursor",
    root: FeedGeneratorsFeedQueryCursorStates,
    events: FeedGeneratorsFeedQueryCursorEvents
});
export type FeedGeneratorsFeedQueryCursorEvent = Machine.EventOf<typeof FeedGeneratorsFeedQueryCursorEvents>;
