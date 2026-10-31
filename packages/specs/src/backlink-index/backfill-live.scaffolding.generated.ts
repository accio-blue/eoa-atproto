// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/backlink-index/backfill-live.qnt
// Spec hash (sha256): f943fefa723a17788317bccc75980da4844af57f5a24cc679e568cde3e549394
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const BacklinkBackfillLiveFields = {
    mode: Schema.String,
    target: Schema.BigInt,
    backfillCursor: Schema.BigInt,
    liveCursor: Schema.BigInt,
    deferred: Schema.BigInt,
    entries: Schema.BigInt
};
export const BacklinkBackfillLiveStates = Machine.state({
    fields: BacklinkBackfillLiveFields
});
export const BacklinkBackfillLiveEvents = Machine.events({
    init: {},
    startBackfill: {
        startTarget: Schema.BigInt
    },
    backfillPage: {
        seq: Schema.BigInt
    },
    liveEvent: {
        seq: Schema.BigInt
    },
    drainDeferred: {}
});
export const BacklinkBackfillLiveDefinition = Machine.make({
    id: "BacklinkBackfillLive",
    root: BacklinkBackfillLiveStates,
    events: BacklinkBackfillLiveEvents
});
export type BacklinkBackfillLiveEvent = Machine.EventOf<typeof BacklinkBackfillLiveEvents>;
