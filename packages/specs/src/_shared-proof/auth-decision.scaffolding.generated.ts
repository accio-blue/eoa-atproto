// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/_shared-proof/auth-decision.qnt
// Spec hash (sha256): 2c89a1c3d7a8248b6d122457ba1a96c4c2b256602c8cf773c5b74f7663029267
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const SharedProofAuthDecisionFields = {
    grant: Schema.String,
    subjectOk: Schema.Boolean,
    verb: Schema.String,
    selectorOk: Schema.Boolean,
    expired: Schema.Boolean,
    allowed: Schema.Boolean
};
export const SharedProofAuthDecisionStates = Machine.state({
    fields: SharedProofAuthDecisionFields
});
export const SharedProofAuthDecisionEvents = Machine.events({
    init: {},
    setGrant: {
        g: Schema.String
    },
    setSubjectOk: {
        b: Schema.Boolean
    },
    setVerb: {
        v: Schema.String
    },
    setSelectorOk: {
        b: Schema.Boolean
    },
    setExpired: {
        b: Schema.Boolean
    }
});
export const SharedProofAuthDecisionDefinition = Machine.make({
    id: "SharedProofAuthDecision",
    root: SharedProofAuthDecisionStates,
    events: SharedProofAuthDecisionEvents
});
export type SharedProofAuthDecisionEvent = Machine.EventOf<typeof SharedProofAuthDecisionEvents>;
