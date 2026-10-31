// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/mail/warming.qnt
// Spec hash (sha256): 9f09e41e23d58900941240c7d4dd80343320bb48333c2e850ddb31c4cb90dc7d
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const MailWarmingFields = {
    tier: Schema.String,
    week: Schema.BigInt,
    day: Schema.BigInt,
    sendsHour: Schema.BigInt,
    sendsDay: Schema.BigInt,
    sent: Schema.BigInt,
    delivered: Schema.BigInt,
    bounces: Schema.BigInt,
    complaints: Schema.BigInt,
    paused: Schema.Boolean,
    sentWhenPaused: Schema.BigInt
};
export const MailWarmingStates = Machine.state({
    fields: MailWarmingFields
});
export const MailWarmingEvents = Machine.events({
    init: {},
    send: {
        outcome: Schema.String
    },
    advanceHour: {},
    advanceDay: {},
    promote: {},
    resume: {}
});
export const MailWarmingDefinition = Machine.make({
    id: "MailWarming",
    root: MailWarmingStates,
    events: MailWarmingEvents
});
export type MailWarmingEvent = Machine.EventOf<typeof MailWarmingEvents>;
