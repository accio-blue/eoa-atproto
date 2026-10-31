// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/oauth/session-lifecycle.qnt
// Spec hash (sha256): f245cc64c5827f32a6adc73f66fd254204ef081dd014d89057b8be2b405ccab7
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const OauthSessionLifecycleFields = {
    stage: Schema.String,
    parPushed: Schema.Boolean,
    codeIssued: Schema.Boolean,
    codeUsed: Schema.Boolean,
    pkceVerified: Schema.Boolean,
    accessGeneration: Schema.BigInt,
    refreshGeneration: Schema.BigInt,
    refreshUsable: Schema.Boolean,
    revoked: Schema.Boolean
};
export const OauthSessionLifecycleStates = Machine.state({
    fields: OauthSessionLifecycleFields
});
export const OauthSessionLifecycleEvents = Machine.events({
    init: {},
    push_request: {},
    authorize: {},
    deny: {},
    exchange: {
        pkce: Schema.Boolean
    },
    refresh: {},
    expire_refresh: {},
    revoke: {}
});
export const OauthSessionLifecycleDefinition = Machine.make({
    id: "OauthSessionLifecycle",
    root: OauthSessionLifecycleStates,
    events: OauthSessionLifecycleEvents
});
export type OauthSessionLifecycleEvent = Machine.EventOf<typeof OauthSessionLifecycleEvents>;
