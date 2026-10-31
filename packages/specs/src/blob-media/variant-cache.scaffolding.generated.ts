// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/blob-media/variant-cache.qnt
// Spec hash (sha256): aae40443e0683e9e4db8afe91b9e04f5096a472ea52cb45563058bc5ac5577b1
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const BlobMediaVariantCacheFields = {
    newest: Schema.String,
    older: Schema.String,
    placed: Schema.BigInt,
    evicted: Schema.BigInt,
    refreshed: Schema.BigInt
};
export const BlobMediaVariantCacheStates = Machine.state({
    fields: BlobMediaVariantCacheFields
});
export const BlobMediaVariantCacheEvents = Machine.events({
    init: {},
    touch: {
        pick: Schema.String
    },
    expire: {}
});
export const BlobMediaVariantCacheDefinition = Machine.make({
    id: "BlobMediaVariantCache",
    root: BlobMediaVariantCacheStates,
    events: BlobMediaVariantCacheEvents
});
export type BlobMediaVariantCacheEvent = Machine.EventOf<typeof BlobMediaVariantCacheEvents>;
