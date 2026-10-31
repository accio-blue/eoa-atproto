// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/relay/subscription-cursor.qnt
// Spec hash (sha256): a99e2b8072bcc3a0c5d6acb2db6f257849f5dea6eb1e233bf700f3cf6a81b04c
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const RelaySubscriptionCursorFields = {
    status: Schema.String,
    cursor: Schema.BigInt,
    resume: Schema.BigInt,
    attempts: Schema.BigInt
};
export const RelaySubscriptionCursorStates = Machine.state({
    fields: RelaySubscriptionCursorFields
});
export const RelaySubscriptionCursorEvents = Machine.events({
    init: {},
    subscribe: {},
    open: {},
    commit: {
        delta: Schema.BigInt
    },
    backfill: {},
    degrade: {},
    retry: {}
});
export const RelaySubscriptionCursorDefinition = Machine.make({
    id: "RelaySubscriptionCursor",
    root: RelaySubscriptionCursorStates,
    events: RelaySubscriptionCursorEvents
});
export type RelaySubscriptionCursorEvent = Machine.EventOf<typeof RelaySubscriptionCursorEvents>;
