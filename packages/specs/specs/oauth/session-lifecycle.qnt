// OAuth provider — the session/token lifecycle.
//
// One authorization grant, traced end to end:
//
//   new -> PAR pushed -> authorized (code issued) -> tokens issued
//        -> refreshed -> revoked
//
// PAR (pushed authorization request), PKCE verification at code exchange,
// token issue/refresh/revoke, and refresh-token expiry are all modelled here.
// Fail-closed paths are first-class actions: the state advances only when the
// guard defs hold, otherwise the action is a no-op (the generator supports no
// action preconditions, so guards live in the assignment RHS).
module oauth_session_lifecycle {
  var stage: str            // "new" | "par_pushed" | "authorized" | "issued" | "refreshed" | "revoked"
  var parPushed: bool       // a request_uri exists (PAR succeeded)
  var codeIssued: bool      // an authorization code was minted
  var codeUsed: bool        // the code has been presented at /token (single use)
  var pkceVerified: bool    // code_verifier matched the code_challenge
  var accessGeneration: int // access tokens issued/rotated
  var refreshGeneration: int// refresh tokens issued/rotated
  var refreshUsable: bool   // refresh token is neither expired nor revoked
  var revoked: bool         // the grant was revoked

  // Guard defs are parameterized: the runtime evaluator resolves def-calls
  // (`f(args)`) but not bare zero-argument def names, so guards take the vars
  // they read as parameters.
  // a code may be exchanged exactly once, and never after revocation
  def canExchange(issued: bool, used: bool, revoked: bool): bool =
    and(and(issued, not(used)), not(revoked))
  // exchange succeeds only when the code is live AND PKCE matches
  def exchangeOk(issued: bool, used: bool, revoked: bool, pkceMatch: bool): bool =
    and(canExchange(issued, used, revoked), pkceMatch)
  // refresh succeeds only while the refresh token is usable and not revoked
  def canRefresh(usable: bool, revoked: bool): bool = and(usable, not(revoked))
  def inAuthorized(s: str): bool = or(s == "par_pushed", s == "authorized")

  action init = all {
    stage' = "new",
    parPushed' = false,
    codeIssued' = false,
    codeUsed' = false,
    pkceVerified' = false,
    accessGeneration' = 0,
    refreshGeneration' = 0,
    refreshUsable' = false,
    revoked' = false
  }

  // PAR: only a brand-new session may push an authorization request
  action push_request = all {
    stage' = if (stage == "new") "par_pushed" else stage,
    parPushed' = if (stage == "new") true else parPushed,
    codeIssued' = codeIssued,
    codeUsed' = codeUsed,
    pkceVerified' = pkceVerified,
    accessGeneration' = accessGeneration,
    refreshGeneration' = refreshGeneration,
    refreshUsable' = refreshUsable,
    revoked' = revoked
  }

  // /authorize approved: mint the single-use code
  action authorize = all {
    stage' = if (stage == "par_pushed") "authorized" else stage,
    parPushed' = parPushed,
    codeIssued' = if (stage == "par_pushed") true else codeIssued,
    codeUsed' = codeUsed,
    pkceVerified' = pkceVerified,
    accessGeneration' = accessGeneration,
    refreshGeneration' = refreshGeneration,
    refreshUsable' = refreshUsable,
    revoked' = revoked
  }

  // user denial: the grant is dead, no tokens
  action deny = all {
    stage' = if (inAuthorized(stage)) "revoked" else stage,
    parPushed' = parPushed,
    codeIssued' = codeIssued,
    codeUsed' = codeUsed,
    pkceVerified' = pkceVerified,
    accessGeneration' = accessGeneration,
    refreshGeneration' = refreshGeneration,
    refreshUsable' = false,
    revoked' = if (inAuthorized(stage)) true else revoked
  }

  // code exchange at /token. `pkce` is the verifier/challenge comparison; a
  // mismatch still burns the code (fail closed) but mints nothing.
  action exchange = {
    nondet pkce = Set(true, false).oneOf()
    all {
      stage' = if (exchangeOk(codeIssued, codeUsed, revoked, pkce)) "issued" else stage,
      parPushed' = parPushed,
      codeIssued' = codeIssued,
      codeUsed' = if (canExchange(codeIssued, codeUsed, revoked)) true else codeUsed,
      pkceVerified' = if (exchangeOk(codeIssued, codeUsed, revoked, pkce)) true else pkceVerified,
      accessGeneration' = if (exchangeOk(codeIssued, codeUsed, revoked, pkce)) accessGeneration + 1 else accessGeneration,
      refreshGeneration' = if (exchangeOk(codeIssued, codeUsed, revoked, pkce)) refreshGeneration + 1 else refreshGeneration,
      refreshUsable' = if (exchangeOk(codeIssued, codeUsed, revoked, pkce)) true else refreshUsable,
      revoked' = revoked
    }
  }

  // refresh_token grant: rotate both tokens
  action refresh = all {
    stage' = if (canRefresh(refreshUsable, revoked)) "refreshed" else stage,
    parPushed' = parPushed,
    codeIssued' = codeIssued,
    codeUsed' = codeUsed,
    pkceVerified' = pkceVerified,
    accessGeneration' = if (canRefresh(refreshUsable, revoked)) accessGeneration + 1 else accessGeneration,
    refreshGeneration' = if (canRefresh(refreshUsable, revoked)) refreshGeneration + 1 else refreshGeneration,
    refreshUsable' = refreshUsable,
    revoked' = revoked
  }

  // the refresh token ages out
  action expire_refresh = all {
    stage' = stage,
    parPushed' = parPushed,
    codeIssued' = codeIssued,
    codeUsed' = codeUsed,
    pkceVerified' = pkceVerified,
    accessGeneration' = accessGeneration,
    refreshGeneration' = refreshGeneration,
    refreshUsable' = false,
    revoked' = revoked
  }

  // /oauth/revoke
  action revoke = all {
    stage' = if (revoked) stage else "revoked",
    parPushed' = parPushed,
    codeIssued' = codeIssued,
    codeUsed' = codeUsed,
    pkceVerified' = pkceVerified,
    accessGeneration' = accessGeneration,
    refreshGeneration' = refreshGeneration,
    refreshUsable' = false,
    revoked' = true
  }

  action step = any { init, push_request, authorize, deny, exchange, refresh, expire_refresh, revoke }

  // no live refresh token once the grant is revoked
  val RevokedCannotRefresh: bool = or(not(revoked), not(refreshUsable))
  // tokens are only ever minted after PKCE verified
  val NoTokenWithoutPkce: bool = or(accessGeneration == 0, pkceVerified)
  // a code cannot exist without a PAR
  val NoCodeWithoutPar: bool = or(not(codeIssued), parPushed)
  // a used code must have been issued first
  val CodeUsedImpliesIssued: bool = or(not(codeUsed), codeIssued)
  // refresh tokens never outnumber access tokens (both rotate together)
  val RefreshWithinAccess: bool = refreshGeneration <= accessGeneration
  val StageValid: bool = or(
    stage == "new",
    stage == "par_pushed",
    stage == "authorized",
    stage == "issued",
    stage == "refreshed",
    stage == "revoked"
  )
}
