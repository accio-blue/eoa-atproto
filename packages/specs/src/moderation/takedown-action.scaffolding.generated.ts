// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/moderation/takedown-action.qnt
// Spec hash (sha256): edfbdfed25af198ccada95523a27ad2bdee59b8fa39d4a53d01bd69955878cdf
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const ModerationTakedownActionFields = {
    enforcement: Schema.String,
    stage: Schema.String,
    temporary: Schema.Boolean,
    applied: Schema.BigInt
};
export const ModerationTakedownActionStates = Machine.state({
    fields: ModerationTakedownActionFields
});
export const ModerationTakedownActionEvents = Machine.events({
    init: {},
    apply: {
        kind: Schema.String
    },
    reverse: {},
    expire: {}
});
export const ModerationTakedownActionDefinition = Machine.make({
    id: "ModerationTakedownAction",
    root: ModerationTakedownActionStates,
    events: ModerationTakedownActionEvents
});
export type ModerationTakedownActionEvent = Machine.EventOf<typeof ModerationTakedownActionEvents>;
