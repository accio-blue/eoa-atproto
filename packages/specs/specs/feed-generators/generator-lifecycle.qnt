// Feed generators: the published generator record and its availability.
//
// A feed generator serves `app.bsky.feed.getFeed` only while its
// `app.bsky.feed.generator` record is published. The author drafts the record,
// publishes it (stamping a version), updates it in place (bumping the
// version), retires it, and may restore it later. A consumer query is answered
// with feed content only while the record is live; every other query is
// rejected as unavailable. The safety property is that availability tracks the
// published status exactly, and every request is answered exactly once.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/feed-generators/generator-lifecycle.test.ts).
module feed_generators_generator_lifecycle {
  var status: str        // "draft" | "published" | "retired"
  var version: int       // published record version, bumped on publish/update
  var recordLive: bool   // whether app.bsky.feed.generator resolves right now
  var everPublished: bool
  var requests: int      // getFeed / getFeedGenerator requests handled
  var served: int        // requests answered with feed content
  var rejected: int      // requests answered "generator unavailable"

  def isPublished(flag: str): bool = flag == "published"

  action init = all {
    status' = "draft",
    version' = 0,
    recordLive' = false,
    everPublished' = false,
    requests' = 0,
    served' = 0,
    rejected' = 0
  }

  action publish = all {
    status' = if (status == "draft") "published" else status,
    version' = if (status == "draft") version + 1 else version,
    recordLive' = if (status == "draft") true else recordLive,
    everPublished' = if (status == "draft") true else everPublished,
    requests' = requests,
    served' = served,
    rejected' = rejected
  }

  // Editing a published record bumps its version in place.
  action update = {
    nondet bump = Set(1, 2).oneOf()
    all {
      status' = status,
      version' = if (status == "published") version + bump else version,
      recordLive' = recordLive,
      everPublished' = everPublished,
      requests' = requests,
      served' = served,
      rejected' = rejected
    }
  }

  action retire = all {
    status' = if (status == "published") "retired" else status,
    version' = version,
    recordLive' = if (status == "published") false else recordLive,
    everPublished' = everPublished,
    requests' = requests,
    served' = served,
    rejected' = rejected
  }

  action restore = all {
    status' = if (status == "retired") "published" else status,
    version' = if (status == "retired") version + 1 else version,
    recordLive' = if (status == "retired") true else recordLive,
    everPublished' = everPublished,
    requests' = requests,
    served' = served,
    rejected' = rejected
  }

  // A consumer calls the generator. Only a live record can answer with feed
  // content; anything else is rejected as unavailable.
  action query = all {
    status' = status,
    version' = version,
    recordLive' = recordLive,
    everPublished' = everPublished,
    requests' = requests + 1,
    served' = if (recordLive) served + 1 else served,
    rejected' = if (recordLive) rejected else rejected + 1
  }

  action step = any { init, publish, update, retire, restore, query }

  val StatusValid: bool = or(
    status == "draft",
    status == "published",
    status == "retired"
  )

  // The record is resolvable exactly while the generator is published.
  val RecordLiveMatchesStatus: bool = recordLive == isPublished(status)

  // Every request is answered exactly once: with content or as unavailable.
  val AccountingExact: bool = requests == served + rejected

  // A generator can never answer with content before it was ever published.
  val NoServeBeforePublish: bool = or(served == 0, everPublished)

  // Publishing always stamps a version.
  val PublishedHasVersion: bool = or(not(everPublished), version >= 1)

  val CountersNonNegative: bool = and(
    version >= 0,
    requests >= 0,
    served >= 0,
    rejected >= 0
  )
}
