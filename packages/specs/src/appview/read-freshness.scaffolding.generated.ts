// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/appview/read-freshness.qnt
// Spec hash (sha256): 9b5ef38f81e382f496371e5cd2997b18e2ad4cb958beb69eac868e477e5cffe4
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const AppviewReadFreshnessFields = {
    indexVersion: Schema.BigInt,
    projectionVersion: Schema.BigInt,
    servedVersion: Schema.BigInt,
    state: Schema.String
};
export const AppviewReadFreshnessStates = Machine.state({
    fields: AppviewReadFreshnessFields
});
export const AppviewReadFreshnessEvents = Machine.events({
    init: {},
    advanceIndex: {
        step: Schema.BigInt
    },
    refreshProjection: {
        step: Schema.BigInt
    },
    read: {
        snapshot: Schema.BigInt
    }
});
export const AppviewReadFreshnessDefinition = Machine.make({
    id: "AppviewReadFreshness",
    root: AppviewReadFreshnessStates,
    events: AppviewReadFreshnessEvents
});
export type AppviewReadFreshnessEvent = Machine.EventOf<typeof AppviewReadFreshnessEvents>;
