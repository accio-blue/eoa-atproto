// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/oauth/dpop-nonce.qnt
// Spec hash (sha256): 58947d72f643df59057a7edbcdfbea0c3565c63a65bf6449029357cfbdd90338
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const OauthDpopNonceFields = {
    phase: Schema.String,
    nextNonce: Schema.BigInt,
    usedNonce: Schema.BigInt,
    nextJti: Schema.BigInt,
    lastJti: Schema.BigInt,
    presentedNonce: Schema.BigInt,
    presentedJti: Schema.BigInt,
    nonceOk: Schema.Boolean,
    jtiOk: Schema.Boolean
};
export const OauthDpopNonceStates = Machine.state({
    fields: OauthDpopNonceFields
});
export const OauthDpopNonceEvents = Machine.events({
    init: {},
    submit: {
        scenario: Schema.BigInt
    },
    rotate: {},
    challenge: {}
});
export const OauthDpopNonceDefinition = Machine.make({
    id: "OauthDpopNonce",
    root: OauthDpopNonceStates,
    events: OauthDpopNonceEvents
});
export type OauthDpopNonceEvent = Machine.EventOf<typeof OauthDpopNonceEvents>;
