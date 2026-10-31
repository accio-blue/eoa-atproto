// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/backlink-index/visibility-gate.qnt
// Spec hash (sha256): 314aa4eb855982bae8d18f5c77915273a70fb9ac8bd5f88d0a458b47163bd987
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const BacklinkVisibilityGateFields = {
    visibility: Schema.String,
    grant: Schema.String,
    subjectMatchesViewer: Schema.Boolean,
    selectorOk: Schema.Boolean,
    expired: Schema.Boolean,
    requested: Schema.Boolean,
    decision: Schema.String
};
export const BacklinkVisibilityGateStates = Machine.state({
    fields: BacklinkVisibilityGateFields
});
export const BacklinkVisibilityGateEvents = Machine.events({
    init: {},
    setVisibility: {
        v: Schema.String
    },
    setGrant: {
        g: Schema.String
    },
    setSubjectMatchesViewer: {
        b: Schema.Boolean
    },
    setSelectorOk: {
        b: Schema.Boolean
    },
    setExpired: {
        b: Schema.Boolean
    },
    lookup: {}
});
export const BacklinkVisibilityGateDefinition = Machine.make({
    id: "BacklinkVisibilityGate",
    root: BacklinkVisibilityGateStates,
    events: BacklinkVisibilityGateEvents
});
export type BacklinkVisibilityGateEvent = Machine.EventOf<typeof BacklinkVisibilityGateEvents>;
