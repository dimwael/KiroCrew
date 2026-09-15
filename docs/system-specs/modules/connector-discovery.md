# Connector provider-capabilities discovery

The capability manifest
(`docs/system-specs/modules/connector-capability-manifest.md`) answers a
static, version-controlled question: *which operations does Kiro Crew intend to
support for this provider.* Provider-capabilities **discovery** answers a
different, live question: *which capabilities does one specific authorized
account binding actually expose right now.* The manifest spec states this
separation directly — discovery "is a separate protocol from the manifest, and
is required regardless of runner status" (connector-capability-manifest.md
§ "Discovery is a separate protocol from the manifest", L355). The two are never
merged into one schema: the manifest is static, discovery is a live probe.

This document specifies the **shape** of the discovery exchange and what a
discovery validator owns. It does not restate the manifest schema, and it does
not define any conformance, run, or receipt structure — those belong to the
manifest and to the conformance/evidence work streams.

## The discovery exchange

The wire shapes are fixed by the manifest spec's discovery section
(connector-capability-manifest.md L355–406). Repeated here only as the surface
this module's validator checks:

```
discovery_request: {
  provider: string                 // never empty
  account_binding: string          // a verified account/tenant binding reference; never empty
  requested_scope_hint: array      // optional; narrows the probe
}

discovery_response: {
  provider: string                 // never empty
  observed_at: timestamp           // when this probe was taken
  scope_snapshot: array            // scopes this binding actually holds at probe time
  capability_rows: [
    {
      operation_id: string | null       // maps to a manifest operation_id when recognizable;
                                         // null when the vendor exposes something the manifest
                                         // does not yet cover
      raw_capability_signature: string  // the vendor's own capability identifier
      matches_manifest: boolean         // the only field linking a row back to the manifest
    }
  ]
  version_snapshot: string         // the vendor surface's own version marker, for drift detection
}
```

## What the discovery validator owns, and only that

`scripts/check_connector_discovery.py` validates the **discovery-unique**
structure above:

- `discovery_request.provider` and `discovery_request.account_binding` are
  present and non-empty strings; `requested_scope_hint`, when present, is an
  array.
- `discovery_response.provider` is present and non-empty; `observed_at` and
  `version_snapshot` are present; `scope_snapshot` is an array.
- Each `capability_rows` entry has `raw_capability_signature` (non-empty
  string), `matches_manifest` (a boolean, not a truthy string or 0/1), and
  `operation_id` that is **either** a non-empty string **or** `null` — null is a
  legitimate value, not a missing field.

### `capability_rows[].operation_id` is nullable and discovery never writes the manifest

`operation_id` is `null` when the vendor exposes a capability the manifest does
not yet cover. A `matches_manifest: false` row is recorded as a gap; per the
manifest spec (L400–404) it "must not be silently dropped, and it must not be
auto-written into the manifest — a human registers a genuinely new vendor
capability." The discovery validator therefore checks that `operation_id` is
*well-formed* (string or null); it does **not** cross-check the id against the
manifest's operation set, and discovery never writes back to the manifest. That
mapping and that registration are human decisions, deliberately outside this
protocol.

## Fields this module deliberately does NOT validate (single-contract rule)

The manifest/run/receipt fields below have exactly one canonical source and one
enforcer each. This module does not re-implement their validation. Two
validators ruling on one field is a defect, not independence — so for each of
these the discovery validator's position is: **not validated here; the named
enforcer below is the sole authority.** A discovery response does not even carry
these fields; there is nothing on a discovery object for this module to rule on.

| Field | Its single home | Sole enforcer | Value set (for reference; not enforced here) |
|---|---|---|---|
| `snapshot_ref` | manifest entry `source.snapshot_ref` (connector-capability-manifest.md L167, L205–206) | manifest validator (`scripts/check_connector_manifest.py`) | resolvable ref, or an explicit placeholder for `not_yet_sourced`; never blank, never a fabricated URL |
| `source_status` | manifest entry `source_status` (connector-capability-manifest.md L166, § "`source_status` — the evidence axis" L50–60) | manifest validator | three values: `user_required` / `official_baseline` / `unverified` |
| `source_kind` | manifest entry `source.source_kind` (connector-capability-manifest.md § L192–210) | manifest validator | six values: `official_docs` / `repo_path` / `format_spec` / `search_snippet_corroborated` / `user_stated` / `not_yet_sourced` |
| `schema_version` | manifest entry `input_schema.schema_version` / `output_schema.schema_version` (connector-capability-manifest.md L170–171, § "Immutable ref binding" L288+) | manifest validator | opaque version string, compared for exact equality against the bound `ConformanceRun` |

### `source_status` and `evidence_tier` are distinct fields — do not merge them

These two are easy to conflate and must not be. They live in different
documents, are enforced by different work streams, and carry **different value
sets**:

- **`source_status`** — the manifest entry's *evidence axis*. Home: the merged
  manifest spec (connector-capability-manifest.md L166, § L50–60). Three values:
  `user_required` / `official_baseline` / `unverified`. It records *where a
  requirement's authority comes from*.
- **`evidence_tier`** — a field of `catalog-evidence.json`, reused by
  `EvidenceReceipt.evidence_tier` per the campaign contract § 6.4. Three values:
  `source_verified_strict` / `search_snippet_or_partial` / `unverified`. It
  records *how strong the captured evidence is*. This is conformance/evidence
  work-stream territory (S2/S4), not the manifest spec and not discovery.

They share only the token `unverified` as one of three values each; the other
two values differ, and the concepts differ (authority-of-requirement vs
strength-of-evidence). Merging them — or aliasing one to the other — would
collapse two contracts into one and is a real defect. Discovery defines neither:
introducing a discovery-local `evidence_tier` would create a *third* home for
one concept, which is exactly the drift the single-contract rule exists to
prevent.

## Sequencing

The discovery validator is a standalone, self-contained checker over the
discovery shapes. It takes no dependency on the manifest validator's code. CI
wiring for this gate is deferred to a named integration step after the manifest
validator (`scripts/check_connector_manifest.py`) merges; until then this module
ships its own unit-tested `--test` self-check and is not wired into the fast
gate.
