//! Politeness toward metadata servers: a minimum gap between requests, and backing off when a
//! server says it is overloaded or we are going too fast (HTTP 429 or 503).
//!
//! The limiter never sleeps and never reads a clock. The caller passes "now" as a time since some
//! fixed start, and sleeps for the delay it is given, so the logic is deterministic to test.

use std::time::Duration;

const MAX_BACKOFF: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
pub struct RateLimiter {
    min_interval: Duration,
    last_request: Option<Duration>,
    blocked_until: Option<Duration>,
    consecutive_refusals: u32,
}

impl RateLimiter {
    pub fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            last_request: None,
            blocked_until: None,
            consecutive_refusals: 0,
        }
    }

    /// How long to wait before the next request may be sent.
    pub fn delay_needed(&self, now: Duration) -> Duration {
        let after_gap = self.last_request.map_or(Duration::ZERO, |last| {
            (last + self.min_interval).saturating_sub(now)
        });
        let after_block = self
            .blocked_until
            .map_or(Duration::ZERO, |until| until.saturating_sub(now));
        after_gap.max(after_block)
    }

    /// Check and record in one step, so that callers on several threads cannot all see "clear to go"
    /// at the same moment. Returns zero when the request may be sent now (and records it as sent);
    /// otherwise the time to wait before asking again. Someone else may take the next slot first, so
    /// the caller must ask again after waiting rather than assuming its turn has come.
    pub fn take(&mut self, now: Duration) -> Duration {
        let delay = self.delay_needed(now);
        if delay.is_zero() {
            self.last_request = Some(now);
        }
        delay
    }

    /// Applies a changed interval setting without forgetting recent requests or refusals.
    pub fn set_min_interval(&mut self, min_interval: Duration) {
        self.min_interval = min_interval;
    }

    pub fn record_request(&mut self, now: Duration) {
        self.last_request = Some(now);
    }

    pub fn record_success(&mut self) {
        self.consecutive_refusals = 0;
        self.blocked_until = None;
    }

    /// The server refused because of load or rate. Honours its `Retry-After` if given, otherwise
    /// doubles the wait each time (the minimum interval, then twice that, ...), up to a minute.
    pub fn record_refusal(&mut self, now: Duration, retry_after: Option<Duration>) {
        self.consecutive_refusals += 1;
        let exponential = self
            .min_interval
            .max(Duration::from_secs(1))
            .saturating_mul(1u32 << self.consecutive_refusals.min(6));
        let wait = retry_after.unwrap_or(exponential).min(MAX_BACKOFF);
        self.blocked_until = Some(now + wait);
    }

    pub fn consecutive_refusals(&self) -> u32 {
        self.consecutive_refusals
    }

    /// How much longer the server's last refusal asks us to stay away (zero when not blocked).
    pub fn blocked_for(&self, now: Duration) -> Duration {
        self.blocked_until
            .map_or(Duration::ZERO, |until| until.saturating_sub(now))
    }

    /// When the last request was sent, as a time since the clock's start.
    pub fn last_request(&self) -> Option<Duration> {
        self.last_request
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECOND: Duration = Duration::from_secs(1);

    #[test]
    fn the_first_request_is_immediate_and_later_ones_keep_the_gap() {
        let mut limiter = RateLimiter::new(Duration::from_millis(1100));
        assert_eq!(limiter.delay_needed(Duration::ZERO), Duration::ZERO);
        limiter.record_request(SECOND * 10);
        assert_eq!(
            limiter.delay_needed(SECOND * 10),
            Duration::from_millis(1100)
        );
        assert_eq!(
            limiter.delay_needed(SECOND * 10 + Duration::from_millis(600)),
            Duration::from_millis(500)
        );
        assert_eq!(limiter.delay_needed(SECOND * 12), Duration::ZERO);
    }

    #[test]
    fn refusals_back_off_exponentially_and_success_resets() {
        let mut limiter = RateLimiter::new(SECOND);
        let now = SECOND * 100;
        limiter.record_refusal(now, None);
        assert_eq!(limiter.delay_needed(now), SECOND * 2);
        limiter.record_refusal(now, None);
        assert_eq!(limiter.delay_needed(now), SECOND * 4);
        limiter.record_refusal(now, None);
        assert_eq!(limiter.delay_needed(now), SECOND * 8);
        assert_eq!(limiter.consecutive_refusals(), 3);
        limiter.record_success();
        assert_eq!(limiter.delay_needed(now), Duration::ZERO);
        assert_eq!(limiter.consecutive_refusals(), 0);
    }

    #[test]
    fn the_wait_is_capped_and_retry_after_is_honoured() {
        let mut limiter = RateLimiter::new(SECOND);
        let now = Duration::ZERO;
        for _ in 0..20 {
            limiter.record_refusal(now, None);
        }
        assert_eq!(limiter.delay_needed(now), Duration::from_secs(60));

        let mut polite = RateLimiter::new(SECOND);
        polite.record_refusal(now, Some(Duration::from_secs(7)));
        assert_eq!(polite.delay_needed(now), Duration::from_secs(7));
        polite.record_refusal(now, Some(Duration::from_secs(3600)));
        assert_eq!(
            polite.delay_needed(now),
            Duration::from_secs(60),
            "even a server's request is capped"
        );
    }

    #[test]
    fn taking_a_turn_records_it_so_only_one_caller_gets_each_slot() {
        let mut limiter = RateLimiter::new(SECOND);
        let now = SECOND * 10;
        assert_eq!(
            limiter.take(now),
            Duration::ZERO,
            "the first caller goes at once"
        );
        assert_eq!(
            limiter.take(now),
            SECOND,
            "a second caller at the same instant must wait"
        );
        assert_eq!(
            limiter.take(now + Duration::from_millis(400)),
            Duration::from_millis(600)
        );
        assert_eq!(
            limiter.take(now + SECOND),
            Duration::ZERO,
            "once the gap has passed the next caller goes"
        );
        assert_eq!(limiter.take(now + SECOND), SECOND);
    }

    #[test]
    fn a_refusal_that_arrives_while_callers_wait_holds_them_back() {
        let mut limiter = RateLimiter::new(SECOND);
        assert_eq!(limiter.take(Duration::ZERO), Duration::ZERO);
        limiter.record_refusal(Duration::ZERO, Some(Duration::from_secs(5)));
        assert_eq!(
            limiter.take(SECOND),
            Duration::from_secs(4),
            "a caller that slept for the gap still has to wait out the block"
        );
    }

    #[test]
    fn the_remaining_block_and_last_request_can_be_read_for_a_status_line() {
        let mut limiter = RateLimiter::new(SECOND);
        assert_eq!(limiter.blocked_for(Duration::ZERO), Duration::ZERO);
        assert_eq!(limiter.last_request(), None);
        limiter.record_request(SECOND * 3);
        limiter.record_refusal(SECOND * 3, Some(Duration::from_secs(10)));
        assert_eq!(limiter.blocked_for(SECOND * 8), Duration::from_secs(5));
        assert_eq!(limiter.blocked_for(SECOND * 20), Duration::ZERO);
        assert_eq!(limiter.last_request(), Some(SECOND * 3));
    }

    #[test]
    fn a_changed_interval_applies_to_the_next_request() {
        let mut limiter = RateLimiter::new(SECOND);
        limiter.record_request(Duration::ZERO);
        limiter.set_min_interval(Duration::from_secs(3));
        assert_eq!(limiter.delay_needed(SECOND), Duration::from_secs(2));
    }

    #[test]
    fn the_longer_of_the_gap_and_the_block_wins() {
        let mut limiter = RateLimiter::new(SECOND);
        limiter.record_request(Duration::ZERO);
        limiter.record_refusal(Duration::ZERO, Some(Duration::from_secs(5)));
        assert_eq!(limiter.delay_needed(Duration::ZERO), Duration::from_secs(5));
        assert_eq!(limiter.delay_needed(Duration::from_secs(4)), SECOND);
    }
}
