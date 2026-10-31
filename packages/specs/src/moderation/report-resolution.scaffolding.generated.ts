// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/moderation/report-resolution.qnt
// Spec hash (sha256): b18413f4edbb4b2d1cb616ef34a9bc862fed5fdd1efb1221c6295ffd883e99b5
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const ModerationReportResolutionFields = {
    report: Schema.String,
    decision: Schema.String,
    appeal: Schema.String
};
export const ModerationReportResolutionStates = Machine.state({
    fields: ModerationReportResolutionFields
});
export const ModerationReportResolutionEvents = Machine.events({
    init: {},
    submit: {},
    triage: {},
    decide: {
        verdict: Schema.String
    },
    fileAppeal: {},
    decideAppeal: {
        ruling: Schema.String
    }
});
export const ModerationReportResolutionDefinition = Machine.make({
    id: "ModerationReportResolution",
    root: ModerationReportResolutionStates,
    events: ModerationReportResolutionEvents
});
export type ModerationReportResolutionEvent = Machine.EventOf<typeof ModerationReportResolutionEvents>;
