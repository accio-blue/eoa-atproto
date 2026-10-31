// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/backlink-index/target-index.qnt
// Spec hash (sha256): beba4a379e82c3254495a4e4021129adeed00270919aa67b03cd63cc9c2ffc22
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const BacklinkTargetIndexFields = {
    entries: Schema.BigInt,
    observed: Schema.BigInt,
    duplicates: Schema.BigInt,
    removed: Schema.BigInt,
    lastTarget: Schema.String,
    lastSource: Schema.String,
    lastDup: Schema.Boolean
};
export const BacklinkTargetIndexStates = Machine.state({
    fields: BacklinkTargetIndexFields
});
export const BacklinkTargetIndexEvents = Machine.events({
    init: {},
    offer: {
        scenario: Schema.BigInt
    },
    retract: {}
});
export const BacklinkTargetIndexDefinition = Machine.make({
    id: "BacklinkTargetIndex",
    root: BacklinkTargetIndexStates,
    events: BacklinkTargetIndexEvents
});
export type BacklinkTargetIndexEvent = Machine.EventOf<typeof BacklinkTargetIndexEvents>;
