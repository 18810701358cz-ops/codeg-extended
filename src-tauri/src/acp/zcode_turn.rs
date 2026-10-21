//! Per-prompt billing and wall time supplied by the ZCode ACP bridge.
//!
//! `usage_update` describes context occupancy, not a billable turn. These
//! counters are already cache-exclusive ACP usage; never subtract the cache
//! again or add the deprecated alias/standard context updates to them.

pub(crate) const TURN_STATE_METHOD: &str = "_zcode/turnState";

pub(crate) fn is_turn_state_method(method: &str) -> bool {
    matches!(method, TURN_STATE_METHOD | "$/zcode/turnState")
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct TurnMetrics {
    pub usage: Option<serde_json::Value>,
    pub duration_ms: Option<u64>,
}

impl TurnMetrics {
    /// Replace measurements on the ONE normal turn-end record, never append a
    /// second end or merge token snapshots additively. Missing extras keep the
    /// ordinary Codeg-measured duration and do not fabricate billing usage.
    pub fn apply_to(&self, payload: &mut serde_json::Value) {
        if let Some(usage) = &self.usage {
            payload["usage"] = usage.clone();
        }
        if let Some(duration_ms) = self.duration_ms {
            payload["durationMs"] = duration_ms.into();
        }
    }
}

/// Constructed for each prompt, observed only inside its update drain, and
/// discarded when Codeg ends that prompt. Load replay and idle notifications never enter
/// this tracker. The protocol has no turn ID: its ordered running/ended pair
/// and the sequential prompt boundary are the available correlation markers.
#[derive(Debug, Default)]
pub(crate) struct TurnTracker {
    running: bool,
    ended: bool,
    metrics: Option<TurnMetrics>,
}

impl TurnTracker {
    pub fn observe(&mut self, method: &str, params: &serde_json::Value, session_id: &str) {
        if method != TURN_STATE_METHOD
            || params.get("sessionId").and_then(|v| v.as_str()) != Some(session_id)
            || self.ended
        {
            return;
        }
        match params.get("running").and_then(|v| v.as_bool()) {
            Some(true) => self.running = true,
            Some(false) if self.running => {
                self.running = false;
                self.ended = true;
                self.metrics = Some(TurnMetrics {
                    usage: params.get("usage").and_then(valid_usage),
                    duration_ms: params.get("turnMs").and_then(|v| v.as_u64()),
                });
            }
            _ => {}
        }
    }

    pub fn metrics(&self) -> Option<&TurnMetrics> {
        self.metrics.as_ref()
    }
}

/// Retain only unsigned ACP counters, without inventing missing values. A bad
/// counter drops the usage report as a whole; the independent clock can still
/// be used. Guard the four-bucket sum the history parser will compute as well.
fn valid_usage(value: &serde_json::Value) -> Option<serde_json::Value> {
    value.as_object()?;
    let mut counters = serde_json::Map::new();
    let mut total = 0_u64;
    let mut billing_counter = false;
    for key in [
        "inputTokens",
        "outputTokens",
        "cachedReadTokens",
        "cachedWriteTokens",
        "totalTokens",
        "thoughtTokens",
    ] {
        let Some(value) = value.get(key).filter(|v| !v.is_null()) else {
            continue;
        };
        let count = value.as_u64()?;
        if matches!(
            key,
            "inputTokens" | "outputTokens" | "cachedReadTokens" | "cachedWriteTokens"
        ) {
            total = total.checked_add(count)?;
            billing_counter = true;
        }
        counters.insert(key.to_string(), count.into());
    }
    billing_counter.then_some(serde_json::Value::Object(counters))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn start(tracker: &mut TurnTracker) {
        tracker.observe(
            TURN_STATE_METHOD,
            &json!({"sessionId":"s", "running":true}),
            "s",
        );
    }

    fn end() -> serde_json::Value {
        json!({"sessionId":"s", "running":false, "turnMs":4200,
            "usage":{"inputTokens":180,"outputTokens":350,"cachedReadTokens":900,
                "cachedWriteTokens":120,"thoughtTokens":200,"totalTokens":1550}})
    }

    #[test]
    fn an_ordered_terminal_report_keeps_cache_exclusive_usage_and_wall_time() {
        let mut tracker = TurnTracker::default();
        start(&mut tracker);
        tracker.observe(TURN_STATE_METHOD, &end(), "s");
        assert_eq!(
            tracker.metrics().unwrap().usage.as_ref().unwrap(),
            &end()["usage"]
        );
        assert_eq!(tracker.metrics().unwrap().duration_ms, Some(4200));
    }

    #[test]
    fn aliases_other_sessions_and_unopened_ends_do_not_count() {
        let mut tracker = TurnTracker::default();
        tracker.observe(TURN_STATE_METHOD, &end(), "s");
        tracker.observe(
            TURN_STATE_METHOD,
            &json!({"sessionId":"other", "running":true}),
            "s",
        );
        tracker.observe(
            "$/zcode/turnState",
            &json!({"sessionId":"s", "running":true}),
            "s",
        );
        tracker.observe(TURN_STATE_METHOD, &end(), "s");
        assert!(tracker.metrics().is_none());
        start(&mut tracker);
        tracker.observe("$/zcode/turnState", &end(), "s");
        assert!(tracker.metrics().is_none());
        tracker.observe(TURN_STATE_METHOD, &end(), "other");
        assert!(tracker.metrics().is_none());
    }

    #[test]
    fn a_terminal_report_is_a_snapshot_and_is_consumed_once() {
        let mut tracker = TurnTracker::default();
        start(&mut tracker);
        tracker.observe(TURN_STATE_METHOD, &end(), "s");
        let mut duplicate = end();
        duplicate["usage"]["inputTokens"] = json!(9999);
        tracker.observe("$/zcode/turnState", &duplicate, "s");
        tracker.observe(TURN_STATE_METHOD, &duplicate, "s");
        start(&mut tracker);
        tracker.observe(TURN_STATE_METHOD, &duplicate, "s");
        assert_eq!(
            tracker.metrics().unwrap().usage.as_ref().unwrap()["inputTokens"],
            180
        );
        let next = TurnTracker::default();
        assert!(
            next.metrics().is_none(),
            "a cancelled or rejected next prompt inherits nothing"
        );
    }

    #[test]
    fn absent_usage_does_not_fabricate_zero_counters() {
        let mut tracker = TurnTracker::default();
        start(&mut tracker);
        tracker.observe(
            TURN_STATE_METHOD,
            &json!({"sessionId":"s","running":false}),
            "s",
        );
        assert_eq!(tracker.metrics(), Some(&TurnMetrics::default()));
    }

    #[test]
    fn malformed_counters_do_not_discard_a_valid_independent_clock() {
        for usage in [
            json!({"inputTokens":-1}),
            json!({"outputTokens":"3"}),
            json!({"inputTokens":1.5}),
            json!({"inputTokens":u64::MAX,"outputTokens":1}),
            json!({"totalTokens":10}),
            json!(null),
        ] {
            let mut tracker = TurnTracker::default();
            start(&mut tracker);
            tracker.observe(
                TURN_STATE_METHOD,
                &json!({"sessionId":"s","running":false,"usage":usage,"turnMs":0}),
                "s",
            );
            assert_eq!(tracker.metrics().unwrap().usage, None);
            assert_eq!(tracker.metrics().unwrap().duration_ms, Some(0));
        }
    }

    #[test]
    fn partial_usage_and_invalid_duration_remain_independent() {
        let mut tracker = TurnTracker::default();
        start(&mut tracker);
        tracker.observe(TURN_STATE_METHOD, &json!({"sessionId":"s","running":false,"usage":{"cachedReadTokens":42,"cachedWriteTokens":null,"other":"ignored"},"turnMs":-5}), "s");
        assert_eq!(
            tracker.metrics().unwrap().usage,
            Some(json!({"cachedReadTokens":42}))
        );
        assert_eq!(tracker.metrics().unwrap().duration_ms, None);
    }

    #[test]
    fn one_turn_end_retains_fallbacks_and_replaces_counters_instead_of_adding() {
        let mut payload = json!({"stopReason":"cancelled","model":"glm-test","durationMs":9999});
        TurnMetrics::default().apply_to(&mut payload);
        assert_eq!(payload["durationMs"], 9999);
        assert!(payload.get("usage").is_none());
        let metrics = TurnMetrics {
            usage: Some(end()["usage"].clone()),
            duration_ms: Some(4200),
        };
        metrics.apply_to(&mut payload);
        metrics.apply_to(&mut payload);
        assert_eq!(payload["usage"], end()["usage"]);
        assert_eq!(payload["durationMs"], 4200);
        assert_eq!(payload["stopReason"], "cancelled");
        assert_eq!(payload["model"], "glm-test");
    }
}
