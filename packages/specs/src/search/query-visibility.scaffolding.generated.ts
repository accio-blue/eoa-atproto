// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/search/query-visibility.qnt
// Spec hash (sha256): d42bb1fc8bf9db4a6d07946dac8393ce1a7d334967a62e467a30e76a4fc4bff4
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const SearchQueryVisibilityFields = {
    visibility: Schema.String,
    grant: Schema.String,
    subjectMatchesViewer: Schema.Boolean,
    selectorOk: Schema.Boolean,
    expired: Schema.Boolean,
    requested: Schema.Boolean,
    decision: Schema.String
};
export const SearchQueryVisibilityStates = Machine.state({
    fields: SearchQueryVisibilityFields
});
export const SearchQueryVisibilityEvents = Machine.events({
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
    runQuery: {}
});
export const SearchQueryVisibilityDefinition = Machine.make({
    id: "SearchQueryVisibility",
    root: SearchQueryVisibilityStates,
    events: SearchQueryVisibilityEvents
});
export type SearchQueryVisibilityEvent = Machine.EventOf<typeof SearchQueryVisibilityEvents>;
