// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/appview/backfill-cursor.qnt
// Spec hash (sha256): 9dd845d15d95dbc428cecd304c381f0ed1a46cff84e1777d3b593b2a13777ebf
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const AppviewBackfillCursorFields = {
    mode: Schema.String,
    target: Schema.BigInt,
    backfillCursor: Schema.BigInt,
    liveCursor: Schema.BigInt,
    deferred: Schema.BigInt
};
export const AppviewBackfillCursorStates = Machine.state({
    fields: AppviewBackfillCursorFields
});
export const AppviewBackfillCursorEvents = Machine.events({
    init: {},
    startBackfill: {
        startTarget: Schema.BigInt
    },
    backfillEvent: {
        seq: Schema.BigInt
    },
    liveEvent: {
        seq: Schema.BigInt
    },
    drainDeferred: {}
});
export const AppviewBackfillCursorDefinition = Machine.make({
    id: "AppviewBackfillCursor",
    root: AppviewBackfillCursorStates,
    events: AppviewBackfillCursorEvents
});
export type AppviewBackfillCursorEvent = Machine.EventOf<typeof AppviewBackfillCursorEvents>;
