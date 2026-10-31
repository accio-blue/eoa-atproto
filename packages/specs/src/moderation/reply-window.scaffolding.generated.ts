// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/moderation/reply-window.qnt
// Spec hash (sha256): fa76686bca51784b0fdc6e59df940709825865da68d431bb74fcb680fbaac0e7
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const ModerationReplyWindowFields = {
    notice: Schema.String,
    window: Schema.String,
    reply: Schema.String,
    rounds: Schema.BigInt
};
export const ModerationReplyWindowStates = Machine.state({
    fields: ModerationReplyWindowFields
});
export const ModerationReplyWindowEvents = Machine.events({
    init: {},
    notify: {},
    submit: {},
    expire: {},
    publish: {},
    discard: {}
});
export const ModerationReplyWindowDefinition = Machine.make({
    id: "ModerationReplyWindow",
    root: ModerationReplyWindowStates,
    events: ModerationReplyWindowEvents
});
export type ModerationReplyWindowEvent = Machine.EventOf<typeof ModerationReplyWindowEvents>;
