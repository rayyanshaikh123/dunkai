"""
ranking.py

Engineering Ranking Engine for CircuitMind's Component Agent.

Responsibilities:
------------------
Takes the Top-K semantically retrieved candidates for a subsystem
request (from retrieval.py) and scores them using deterministic
engineering criteria -- NOT another semantic/LLM pass.

Scored dimensions (weights sum to 100):

    semantic_similarity     25   -- FAISS similarity_score from retrieval
    interface_match         25   -- request["interfaces"] + power_interfaces
                                    found in the candidate's own text
    stock_availability       15   -- log-scaled against a reference stock level
    price_competitiveness    15   -- relative to the other candidates for
                                    *this* request, at the requested build qty
    category_precision        5   -- subsystem keyword found in subcategory/desc
    manufacturer_preference    5   -- optional config.PREFERRED_MANUFACTURERS
    package_preference          5   -- optional config.PREFERRED_PACKAGES
    lifecycle_health             5   -- RoHS + no obsolete/EOL/NRND flags

This module does NOT talk to FAISS, the LLM, or the dataset directly --
it only operates on the dicts retrieval.py already produced.
"""

from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional

import catalogue
import config
import coverage
import utils
import suitability

logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------
# Weights (overridable via config.RANKING_WEIGHTS without editing this file)
# ---------------------------------------------------------------------

DEFAULT_WEIGHTS = {
    "semantic_similarity": 25.0,
    "interface_match": 25.0,
    "stock_availability": 15.0,
    "price_competitiveness": 15.0,
    "category_precision": 5.0,
    "manufacturer_preference": 5.0,
    "package_preference": 5.0,
    "lifecycle_health": 5.0,
}

# Stock level (units) that earns a full stock_availability score.
# Override with config.STOCK_REFERENCE if you want it tighter/looser.
DEFAULT_STOCK_REFERENCE = 5000


def _get_weights() -> Dict[str, float]:
    configured = getattr(config, "RANKING_WEIGHTS", None)
    if isinstance(configured, dict) and configured:
        weights = dict(DEFAULT_WEIGHTS)
        weights.update(configured)
        return weights
    return dict(DEFAULT_WEIGHTS)


def _get_stock_reference() -> int:
    return int(getattr(config, "STOCK_REFERENCE", DEFAULT_STOCK_REFERENCE))


def _get_preferred_manufacturers() -> List[str]:
    values = getattr(config, "PREFERRED_MANUFACTURERS", None)
    if isinstance(values, (list, tuple)):
        return [str(v).lower() for v in values]
    return []


def _get_preferred_packages() -> List[str]:
    values = getattr(config, "PREFERRED_PACKAGES", None)
    if isinstance(values, (list, tuple)):
        return [str(v).lower() for v in values]
    return []


def _get_build_quantity(request: Dict[str, Any]) -> int:
    qty = request.get("build_quantity") or getattr(config, "DEFAULT_QTY", 1)
    try:
        return max(1, int(qty))
    except (TypeError, ValueError):
        return 1


# ---------------------------------------------------------------------
# Individual scoring dimensions -- each returns a fraction in [0, 1]
# ---------------------------------------------------------------------

def _score_semantic_similarity(candidate: Dict[str, Any]) -> float:
    similarity = candidate.get("similarity_score", 0.0)
    try:
        similarity = float(similarity)
    except (TypeError, ValueError):
        similarity = 0.0
    # Normalized BGE embeddings -> inner product is cosine similarity,
    # typically in [0, 1] for related text but can dip slightly negative.
    return max(0.0, min(1.0, similarity))


# Values a catalogue attribute uses to mean "not populated". Treated as ABSENT
# evidence, never as a negative answer.
_ATTR_PLACEHOLDERS = {"", "-", "--", "n/a", "na", "none", "null", "unknown"}

# Confidence tiers for interface evidence. Full marks require STRUCTURED proof;
# free text can never reach 1.0, because a datasheet blurb mentioning "I2C" is
# marketing copy, not a capability claim.
_IFACE_VERIFIED_MATCH = 1.00     # real resolved pins confirm it -> strongest
_IFACE_VERIFIED_ABSENT = 0.05    # every pad named, interface genuinely absent
_IFACE_STRUCTURED_MATCH = 1.00   # attribute names the interface -> believe it
_IFACE_TEXT_ONLY = 0.60          # only free text mentions it -> weak, unverified
_IFACE_NO_EVIDENCE = 0.30        # nothing either way -> unknown, not a failure
_IFACE_STRUCTURED_CONTRADICTS = 0.15  # attribute lists interfaces, ours absent


def _structured_interfaces(candidate: Dict[str, Any]) -> Optional[str]:
    """Interface text from STRUCTURED catalogue attributes only.

    Returns None when the part carries no populated interface attribute — which
    means *unknown*, not *absent*. Distinguishing those two is the whole point of
    this function: only 18 of 240 real candidates surveyed carried a populated
    `Interface` attribute (all in one subsystem), so treating its absence as a
    negative would fail ~92% of parts for lacking a field the catalogue simply
    does not fill in.
    """
    attributes = utils.get_attributes(candidate)
    if not isinstance(attributes, dict):
        return None

    values = [
        str(value)
        for key, value in attributes.items()
        if "interface" in str(key).lower()
        and str(value).strip().lower() not in _ATTR_PLACEHOLDERS
    ]
    return " ".join(values).lower() if values else None


def _score_interface_match(candidate: Dict[str, Any], request: Dict[str, Any]) -> float:
    """Score how well a candidate satisfies the requested interfaces.

    Previously this substring-matched the request against
    `utils.get_searchable_text()` — description, title, subcategory, category,
    mfr_part and every attribute value flattened into one blob. At 25 points
    (tied heaviest weight) that rewarded a part for MENTIONING an interface
    rather than having one: any datasheet blurb containing "I2C" scored full
    marks. That is very likely part of why parts lacking a requested function
    kept winning their role.

    Structured attribute data is now required for full marks. Three states are
    kept genuinely distinct, because collapsing them is how a "don't know"
    becomes a false claim:

      verified pins .......... 1.00  resolved footprint confirms it (strongest)
      verified absent ........ 0.05  every pad named, interface genuinely absent
      confirmed by attribute .. 1.00  the catalogue says it has this
      free text only ......... 0.60  plausible, unverified — cannot reach 1.0
      no evidence ............ 0.30  unknown; NOT scored as absent
      attribute contradicts .. 0.15  the one sound negative

    Note the last is 0.15 rather than 0.0: a populated interface attribute is
    not guaranteed exhaustive, so it is strong evidence against, not proof.
    """
    # Prefer the structured requirements from parser.py, which have already had
    # Power and the wireless three removed by interface_taxonomy. Scoring those
    # was never meaningful: "has Power" is true of every part in the catalogue
    # (and Power was more than half of all observed edges), and BLE/WiFi/RF
    # describe a link through the air, so no board-level part requirement
    # exists for them at all.
    #
    # Falls back to the flat lists when `interface_requirements` is absent, so a
    # hand-built request (tests, the __main__ demo) still scores as before.
    structured = request.get("interface_requirements")
    if structured is not None:
        source = [
            entry.get("interface")
            for entry in structured
            if entry.get("relationship") != "not_applicable"
        ]
    else:
        source = (request.get("interfaces") or []) + (request.get("power_interfaces") or [])

    required = set(
        i.strip().lower()
        for i in source
        if i and str(i).strip()
    )
    if not required:
        # Nothing specific was required, so nothing to fail on.
        return 1.0

    # Tier 0 — verified pin data from the downstream PCB module. This is the
    # only evidence derived from the part's REAL resolved footprint, so it
    # outranks both catalogue attributes and free text.
    #
    # Returns None for every unknown case (part not resolved, or naming
    # incomplete so absence is unproven). None falls through to the tiers below
    # rather than becoming a score — collapsing "not checked" into "absent" is
    # the false negative this whole scoring function exists to avoid.
    confidences = {
        interface: coverage.interface_confidence(candidate, interface)
        for interface in required
    }

    # A verified ABSENCE on any required interface is disqualifying, and is
    # applied as a ceiling rather than as one term in an average.
    #
    # This previously averaged: `matched / len(required)` counted the confirmed
    # interfaces and silently DISCARDED the verified-absent ones. A part proven
    # to lack a required bus therefore scored 1.00 * (1/2) = 0.50 whenever it
    # confirmed some other required interface — beating a part where that bus
    # was merely unknown (0.30). Real instance: AD4057, a linear charger with a
    # fully-named 6-pad footprint and no I2C, won U2 against an I2C net because
    # its confirmed Power rail averaged the proven absence away.
    #
    # Partial credit is meaningless here: if the part cannot carry a required
    # net, the other interfaces it does have will not make the design build. So
    # a proven "no" can never outrank an "unknown", no matter how many other
    # required interfaces the part confirms.
    if any(c is not None and c <= 0.0 for c in confidences.values()):
        return _IFACE_VERIFIED_ABSENT

    confirmed = [i for i, c in confidences.items() if c is not None and c >= 1.0]
    if confirmed:
        if len(confirmed) == len(required):
            return _IFACE_VERIFIED_MATCH
        # The rest are unknown, not absent. Scale by what was actually proven,
        # but never below the no-evidence score: having confirmed SOME required
        # interface must not rank worse than having confirmed none.
        return max(
            _IFACE_NO_EVIDENCE,
            _IFACE_VERIFIED_MATCH * (len(confirmed) / len(required)),
        )

    structured = _structured_interfaces(candidate)
    if structured is not None:
        matched = sum(1 for interface in required if interface in structured)
        if matched:
            # Partial credit scales, but a full match earns the full score.
            return _IFACE_STRUCTURED_MATCH * (matched / len(required))
        return _IFACE_STRUCTURED_CONTRADICTS

    # No structured interface data for this part. Fall back to free text, but
    # capped — this is a hint, not a capability claim.
    text = utils.get_searchable_text(candidate)
    matched = sum(1 for interface in required if interface in text)
    if matched:
        return _IFACE_TEXT_ONLY * (matched / len(required))
    return _IFACE_NO_EVIDENCE


def _score_stock_availability(candidate: Dict[str, Any]) -> float:
    stock = utils.get_stock(candidate)
    if stock <= 0:
        return 0.0
    reference = _get_stock_reference()
    score = math.log10(stock + 1) / math.log10(reference + 1)
    return max(0.0, min(1.0, score))


def _score_category_precision(candidate: Dict[str, Any], request: Dict[str, Any]) -> float:
    subsystem = str(request.get("subsystem", "")).lower()
    if not subsystem:
        return 0.5

    keywords = [w for w in subsystem.replace("-", " ").split() if len(w) > 2]
    if not keywords:
        return 0.5

    haystack = " ".join([
        str(candidate.get("subcategory", "")),
        str(candidate.get("description", "")),
    ]).lower()

    matched = sum(1 for kw in keywords if kw in haystack)
    return matched / len(keywords)


def _score_manufacturer_preference(candidate: Dict[str, Any]) -> float:
    preferred = _get_preferred_manufacturers()
    if not preferred:
        return 0.7  # neutral baseline -- no configured preference

    manufacturer = str(candidate.get("manufacturer", "")).lower()
    return 1.0 if any(p in manufacturer for p in preferred) else 0.3


def _score_package_preference(candidate: Dict[str, Any]) -> float:
    preferred = _get_preferred_packages()
    if not preferred:
        return 0.5  # neutral baseline -- no configured preference

    package = str(candidate.get("package", "")).lower()
    return 1.0 if any(p in package for p in preferred) else 0.4


def _score_lifecycle_health(candidate: Dict[str, Any]) -> float:
    if utils.has_lifecycle_risk(candidate):
        return 0.0
    rohs = utils.is_rohs_compliant(candidate)
    if rohs is True:
        return 1.0
    if rohs is False:
        return 0.4
    return 0.7  # unknown RoHS status, no lifecycle red flags


def _score_price_competitiveness(
    candidate: Dict[str, Any],
    all_unit_prices: List[float],
) -> float:
    price = utils.get_unit_price(candidate, 1)
    known_prices = [p for p in all_unit_prices if p is not None]

    if price is None:
        return 0.3  # unknown price -- mild penalty, not disqualifying
    if not known_prices or max(known_prices) == min(known_prices):
        return 1.0  # only one price point in this candidate set -- no basis to penalize

    lo, hi = min(known_prices), max(known_prices)
    # Cheaper -> closer to 1.0
    return 1.0 - ((price - lo) / (hi - lo))


# ---------------------------------------------------------------------
# Public ranking API
# ---------------------------------------------------------------------

class ComponentRanker:
    """Deterministic engineering ranker for semantically retrieved candidates."""

    def __init__(self, weights: Optional[Dict[str, float]] = None):
        self.weights = weights or _get_weights()
        total = sum(self.weights.values())
        if not math.isclose(total, 100.0, abs_tol=0.01):
            logger.warning(
                "Ranking weights sum to %.2f, not 100 -- scores will still be "
                "comparable to each other but won't read as a clean 0-100 scale.",
                total,
            )

    # ------------------------------------------------------------------
    def score_candidate(
        self,
        candidate: Dict[str, Any],
        request: Dict[str, Any],
        unit_price: float,
        all_unit_prices: List[float],
    ) -> Dict[str, Any]:
        """Score one candidate and attach a breakdown + total score."""

        breakdown = {
            "semantic_similarity": _score_semantic_similarity(candidate),
            "interface_match": _score_interface_match(candidate, request),
            "stock_availability": _score_stock_availability(candidate),
            "price_competitiveness": _score_price_competitiveness(candidate, all_unit_prices),
            "category_precision": _score_category_precision(candidate, request),
            "manufacturer_preference": _score_manufacturer_preference(candidate),
            "package_preference": _score_package_preference(candidate),
            "lifecycle_health": _score_lifecycle_health(candidate),
        }

        weighted = {
            dimension: round(fraction * self.weights.get(dimension, 0.0), 2)
            for dimension, fraction in breakdown.items()
        }
        total_score = round(sum(weighted.values()), 2)

        return {
            **candidate,
            "unit_price": unit_price,
            "score": total_score,
            "score_breakdown": weighted,
        }

    # ------------------------------------------------------------------
    def rank(self, retrieval_result: Dict[str, Any]) -> Dict[str, Any]:
        """
        Rank the candidates inside one retrieval result (the dict shape
        returned by ComponentRetriever.retrieve()).
        """
        request = retrieval_result.get("request", {})
        offered = retrieval_result.get("candidates", [])
        rejected = [{"mfr_part": utils.get_mfr_part(c), "reason": suitability.mismatch(c, request)} for c in offered]
        rejected = [r for r in rejected if r["reason"]]
        candidates = [c for c in offered if suitability.mismatch(c, request) is None]
        if offered and not candidates:
            request["match_issue"] = f"No catalogue candidate proves the required function for {request.get('subsystem', 'this subsystem')}. Specify a suitable component or an explicit external-device interface."
        build_qty = _get_build_quantity(request)

        unit_prices = [utils.get_unit_price(c, build_qty) for c in candidates]

        scored = [
            self.score_candidate(candidate, request, price, unit_prices)
            for candidate, price in zip(candidates, unit_prices)
        ]

        scored.sort(key=lambda c: c["score"], reverse=True)

        logger.info(
            "Ranked %d candidates for %s (%s)",
            len(scored),
            request.get("reference", "?"),
            request.get("subsystem", "?"),
        )

        return {
            **retrieval_result,
            "ranked_candidates": scored,
            "function_rejections": rejected,
            "best_candidate": scored[0] if scored else None,
        }

    # ------------------------------------------------------------------
    def rank_all(self, retrieval_results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        ranked_results = []
        selected_parts: set[str] = set()

        for result in retrieval_results:
            ranked = self.rank(result)
            if not ranked["ranked_candidates"]:
                ranked_results.append(ranked)
                continue

            unused = [c for c in ranked["ranked_candidates"] if utils.get_mfr_part(c) not in selected_parts]
            chosen = self._first_orderable(unused, ranked)
            if chosen is not None:
                ranked["best_candidate"] = chosen
            elif unused:
                ranked["best_candidate"] = unused[0]
            else:
                # every candidate is already used elsewhere -- keep top pick, flag it
                ranked["best_candidate"]["duplicate_warning"] = True

            selected_parts.add(utils.get_mfr_part(ranked["best_candidate"]))
            ranked_results.append(ranked)

        return ranked_results

    # ------------------------------------------------------------------
    #: How far down the ranking to look for an orderable part. Each look is one
    #: catalogue query (cached per part), so this bounds the added latency.
    CATALOGUE_DEPTH = 6

    def _first_orderable(self, candidates: List[Dict[str, Any]], ranked: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """The best-ranked candidate the JLCPCB catalogue actually stocks.

        A part not in the catalogue is dropped later by the board stage, taking
        its connections with it (see catalogue.py). Unknown -- catalogue
        unreachable, or the check disabled -- counts as orderable, so this never
        makes an offline run worse than it was. Returns None when every checked
        candidate is confirmed absent; the caller then keeps the old top pick.
        """
        skipped = []
        for candidate in candidates[: self.CATALOGUE_DEPTH]:
            part = utils.get_mfr_part(candidate)
            extra = candidate.get("extra_params")
            number = extra.get("number") if isinstance(extra, dict) else None
            ok, listing = catalogue.verdict(part, number)
            if ok is False:
                skipped.append(part)
                continue
            if listing:
                # The board stage resolves fastest and surest by catalogue number
                # (its tier 1). Record it when the dataset did not carry one.
                if isinstance(extra, dict) and not extra.get("number"):
                    extra["number"] = listing["lcsc"].lstrip("C")
                candidate["catalogue_verified"] = True
            if skipped:
                ranked["catalogue_skipped"] = skipped
                logger.info("Skipped %s: not in the JLCPCB catalogue; chose %s", ", ".join(skipped), part)
            return candidate
        if skipped:
            ranked["catalogue_skipped"] = skipped
            logger.warning("None of %s are in the JLCPCB catalogue; keeping the top pick", ", ".join(skipped))
        return None


if __name__ == "__main__":
    from retrieval import ComponentRetriever

    retriever = ComponentRetriever()
    ranker = ComponentRanker()

    request = {
        "reference": "U1",
        "type": "sensor",
        "subsystem": "Temperature Sensor",
        "category": "Sensor",
        "interfaces": ["I2C"],
        "power_interfaces": [],
    }

    retrieval_result = retriever.retrieve(request)
    ranked_result = ranker.rank(retrieval_result)

    print("\nRanked candidates:\n")
    for i, candidate in enumerate(ranked_result["ranked_candidates"][:5], start=1):
        print(f"{i}. {candidate['manufacturer']} - {utils.get_mfr_part(candidate)}")
        print(f"   Score: {candidate['score']}  Breakdown: {candidate['score_breakdown']}")
        print(f"   {candidate['description']}\n")
