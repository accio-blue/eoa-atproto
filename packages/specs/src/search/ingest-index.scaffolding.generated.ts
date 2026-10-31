// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/search/ingest-index.qnt
// Spec hash (sha256): 61514211d72fa5cba4e8098e31e0a49bb16ba6f1d86f86bda0f5baa76714b2fc
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const SearchIngestIndexFields = {
    phase: Schema.String,
    cursor: Schema.BigInt,
    buffer: Schema.BigInt,
    docs: Schema.BigInt,
    tombstones: Schema.BigInt
};
export const SearchIngestIndexStates = Machine.state({
    fields: SearchIngestIndexFields
});
export const SearchIngestIndexEvents = Machine.events({
    init: {},
    startStream: {},
    receive: {
        delta: Schema.BigInt
    },
    indexRecord: {},
    deleteDoc: {}
});
export const SearchIngestIndexDefinition = Machine.make({
    id: "SearchIngestIndex",
    root: SearchIngestIndexStates,
    events: SearchIngestIndexEvents
});
export type SearchIngestIndexEvent = Machine.EventOf<typeof SearchIngestIndexEvents>;
