// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/moderation/appeal-lifecycle.qnt
// Spec hash (sha256): 70057bcca5ca011d9410a8c87ccecad5ded108f8460c90c8f7562d6fefe6f438
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const ModerationAppealLifecycleFields = {
    appeal: Schema.String,
    filing: Schema.String,
    standing: Schema.Boolean
};
export const ModerationAppealLifecycleStates = Machine.state({
    fields: ModerationAppealLifecycleFields
});
export const ModerationAppealLifecycleEvents = Machine.events({
    init: {},
    enforce: {},
    lapse: {},
    file: {},
    review: {},
    rule: {
        grant: Schema.Boolean
    }
});
export const ModerationAppealLifecycleDefinition = Machine.make({
    id: "ModerationAppealLifecycle",
    root: ModerationAppealLifecycleStates,
    events: ModerationAppealLifecycleEvents
});
export type ModerationAppealLifecycleEvent = Machine.EventOf<typeof ModerationAppealLifecycleEvents>;
