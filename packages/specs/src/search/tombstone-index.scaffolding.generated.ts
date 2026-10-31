// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/search/tombstone-index.qnt
// Spec hash (sha256): 766e8dc9faf209e32881bd96340a6f6c8e728e898a2713a8bf1a9b1c1707f0bb
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const SearchTombstoneIndexFields = {
    entry: Schema.String,
    revision: Schema.BigInt,
    requested: Schema.Boolean,
    decision: Schema.String
};
export const SearchTombstoneIndexStates = Machine.state({
    fields: SearchTombstoneIndexFields
});
export const SearchTombstoneIndexEvents = Machine.events({
    init: {},
    ingest: {
        version: Schema.BigInt
    },
    deleteDoc: {},
    runQuery: {}
});
export const SearchTombstoneIndexDefinition = Machine.make({
    id: "SearchTombstoneIndex",
    root: SearchTombstoneIndexStates,
    events: SearchTombstoneIndexEvents
});
export type SearchTombstoneIndexEvent = Machine.EventOf<typeof SearchTombstoneIndexEvents>;
