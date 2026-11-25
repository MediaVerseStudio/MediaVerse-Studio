//! One gate for every request to an outside service (D108). Each service ("source") has one stream of requests: a
//! minimum gap, back-off when it refuses, and a queue in which the most urgent waiter goes first:
//!
//! - **Interactive**: the person is waiting on it (a disc lookup, a search by name, a comparison they asked for).
//! - **Visible**: something on screen is filling in (the default).
//! - **Bulk**: library-wide scans and fixes. Bulk work also steps aside for ten seconds after an interactive request
//!   to the same source, so a lookup's follow-up questions are not stuck behind a scan.
//!
//! An interactive request waits only a short while (the *budget*); if the source is still not ready it gives up with a
//! plain "busy" answer, and the page asks again by itself. Everything else waits as long as it takes.
//! Priority is a property of the thread doing the work (set when a command is dispatched, copied into the jobs it
//! starts), so the call sites that make the requests do not each have to pass it.

use mediaverse_disc_metadata::rate::RateLimiter;
use serde_json::{Value, json};
use std::cell::Cell;
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Priority {
    Interactive,
    Visible,
    Bulk,
}

thread_local! {
    static CURRENT: Cell<Priority> = const { Cell::new(Priority::Visible) };
}

/// The priority of requests made by this thread.
pub fn current_priority() -> Priority {
    CURRENT.with(Cell::get)
}

/// Sets this thread's priority until the guard is dropped.
pub struct PriorityGuard(Priority);

pub fn priority(priority: Priority) -> PriorityGuard {
    PriorityGuard(CURRENT.with(|c| c.replace(priority)))
}

impl Drop for PriorityGuard {
    fn drop(&mut self) {
        CURRENT.with(|c| c.set(self.0));
    }
}

/// How the commands the interface sends map to priorities. Everything not listed is `Visible`.
pub fn priority_for(command: &str) -> Priority {
    match command {
        "lookup_disc"
        | "search_albums"
        | "search_folder_album"
        | "check_folder_audio"
        | "submit_gnudb"
        | "compare_album_release"
        | "adopt_release_values" => Priority::Interactive,
        "scan_tag_repair"
        | "lyric_ai_analyse"
        | "lyric_ai_judge"
        | "lyric_ai_time"
        | "lyric_ai_draft"
        | "lyric_ai_wrong_check"
        | "lyric_photos_read"
        | "lyric_photos_download"
        | "scan_mb_ids"
        | "scan_audio_check"
        | "scan_album_align"
        | "check_artist_names"
        | "find_wiki_photos"
        | "canonical_artist_names" => Priority::Bulk,
        _ => Priority::Visible,
    }
}

/// How long an interactive request waits for its turn before saying the source is busy.
pub const INTERACTIVE_BUDGET: Duration = Duration::from_secs(8);
/// Bulk work leaves a source alone this long after an interactive request to it.
const BULK_STEP_ASIDE: Duration = Duration::from_secs(10);
/// A waiting request looks again at least this often (its priority or the source's state may have changed).
const SLICE: Duration = Duration::from_millis(250);

struct Source {
    limiter: RateLimiter,
    /// Requests waiting for a turn: (priority, arrival number).
    waiting: Vec<(Priority, u64)>,
    last_ok: Option<Duration>,
    last_interactive: Option<Duration>,
}

/// Why an interactive request was not sent: the source is not ready within the budget.
#[derive(Debug)]
pub struct Busy {
    /// How long until the source would be ready, as far as is known.
    pub retry_in: Duration,
}

pub struct Scheduler {
    sources: Mutex<HashMap<String, Source>>,
    started: Instant,
    arrivals: AtomicU64,
    step_aside: Duration,
}

impl Default for Scheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl Scheduler {
    pub fn new() -> Self {
        Self::with_step_aside(BULK_STEP_ASIDE)
    }

    /// A scheduler whose bulk work stands aside for `step_aside` after an interactive request (tests use a short one).
    pub fn with_step_aside(step_aside: Duration) -> Self {
        Self {
            sources: Mutex::new(HashMap::new()),
            started: Instant::now(),
            arrivals: AtomicU64::new(0),
            step_aside,
        }
    }

    fn now(&self) -> Duration {
        self.started.elapsed()
    }

    /// Waits for this source's turn, whatever it takes. Returns when the request may be sent (and records it).
    pub fn wait(&self, source: &str, min_interval: Duration) {
        let _ = self.acquire(source, min_interval, None);
    }

    /// Like [`wait`](Self::wait), but a request made for the person (interactive) gives up after the budget with
    /// [`Busy`]; any other request waits as long as it takes.
    pub fn wait_for_person(&self, source: &str, min_interval: Duration) -> Result<(), Busy> {
        let budget = (current_priority() == Priority::Interactive).then_some(INTERACTIVE_BUDGET);
        self.acquire(source, min_interval, budget)
    }

    fn acquire(
        &self,
        source: &str,
        min_interval: Duration,
        budget: Option<Duration>,
    ) -> Result<(), Busy> {
        let me = current_priority();
        let arrival = self.arrivals.fetch_add(1, Ordering::Relaxed);
        let entered = Instant::now();
        let ticket = (me, arrival);
        // However this returns, the ticket leaves the queue.
        struct Leave<'a>(&'a Scheduler, &'a str, (Priority, u64));
        impl Drop for Leave<'_> {
            fn drop(&mut self) {
                if let Ok(mut sources) = self.0.sources.lock()
                    && let Some(source) = sources.get_mut(self.1)
                {
                    source.waiting.retain(|t| *t != self.2);
                }
            }
        }
        {
            let mut sources = self.sources.lock().expect("sources");
            let entry = sources.entry(source.to_owned()).or_insert_with(|| Source {
                limiter: RateLimiter::new(min_interval),
                waiting: Vec::new(),
                last_ok: None,
                last_interactive: None,
            });
            entry.waiting.push(ticket);
        }
        let _leave = Leave(self, source, ticket);
        loop {
            let delay = {
                let mut sources = self.sources.lock().expect("sources");
                let now = self.now();
                let entry = sources.get_mut(source).expect("source");
                entry.limiter.set_min_interval(min_interval); // the person may have changed it since last time
                if me == Priority::Interactive {
                    entry.last_interactive = Some(now);
                }
                let first_in_line = entry.waiting.iter().min() == Some(&ticket);
                let stepping_aside = me == Priority::Bulk
                    && entry
                        .last_interactive
                        .is_some_and(|at| now.saturating_sub(at) < self.step_aside);
                if first_in_line && !stepping_aside {
                    let delay = entry.limiter.take(now);
                    if delay.is_zero() {
                        return Ok(());
                    }
                    delay
                } else {
                    // Not our turn: look again soon.
                    SLICE
                }
            };
            if let Some(budget) = budget {
                let expected = {
                    let sources = self.sources.lock().expect("sources");
                    sources
                        .get(source)
                        .map_or(Duration::ZERO, |s| s.limiter.delay_needed(self.now()))
                };
                // Already waited the budget, or the source says to stay away longer than that.
                if entered.elapsed() >= budget || expected > budget {
                    return Err(Busy {
                        retry_in: expected.max(delay),
                    });
                }
            }
            std::thread::sleep(delay.min(SLICE));
        }
    }

    /// Records how a request went: refused (overloaded or rate-limited, with the server's `Retry-After` if given) or fine.
    pub fn outcome(&self, source: &str, refused: bool, retry_after: Option<Duration>) {
        if let Ok(mut sources) = self.sources.lock()
            && let Some(entry) = sources.get_mut(source)
        {
            let now = self.now();
            if refused {
                entry.limiter.record_refusal(now, retry_after);
            } else {
                entry.limiter.record_success();
                entry.last_ok = Some(now);
            }
        }
    }

    /// One line per source asked so far, for the status shown on the pages.
    /// `state`: `ok`, `slowed` (the last answer was a refusal), `down` (three or more refusals in a row).
    pub fn status(&self) -> Value {
        let sources = self.sources.lock().expect("sources");
        let now = self.now();
        let mut rows: Vec<(String, Value)> = sources
            .iter()
            .map(|(name, s)| {
                let refusals = s.limiter.consecutive_refusals();
                let state = if refusals >= 3 { "down" } else if refusals > 0 { "slowed" } else { "ok" };
                let ago = |at: Option<Duration>| at.map(|at| now.saturating_sub(at).as_secs());
                (
                    name.clone(),
                    json!({
                        "source": name, "state": state, "refusals": refusals,
                        "retry_in_seconds": s.limiter.blocked_for(now).as_secs(),
                        "waiting": s.waiting.len(),
                        "last_ok_seconds_ago": ago(s.last_ok), "last_request_seconds_ago": ago(s.limiter.last_request()),
                    }),
                )
            })
            .collect();
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        json!({ "sources": rows.into_iter().map(|(_, v)| v).collect::<Vec<_>>() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const GAP: Duration = Duration::from_millis(120);

    #[test]
    fn priorities_follow_the_command() {
        assert_eq!(priority_for("lookup_disc"), Priority::Interactive);
        assert_eq!(priority_for("scan_mb_ids"), Priority::Bulk);
        assert_eq!(priority_for("list_tag_repair"), Priority::Visible);
        assert!(Priority::Interactive < Priority::Visible && Priority::Visible < Priority::Bulk);
    }

    #[test]
    fn the_guard_sets_and_restores_this_threads_priority() {
        assert_eq!(current_priority(), Priority::Visible);
        {
            let _bulk = priority(Priority::Bulk);
            assert_eq!(current_priority(), Priority::Bulk);
            {
                let _person = priority(Priority::Interactive);
                assert_eq!(current_priority(), Priority::Interactive);
            }
            assert_eq!(current_priority(), Priority::Bulk);
        }
        assert_eq!(current_priority(), Priority::Visible);
    }

    #[test]
    fn an_interactive_request_goes_before_bulk_requests_already_waiting() {
        let scheduler = Arc::new(Scheduler::with_step_aside(Duration::from_millis(300)));
        scheduler.wait("site", GAP); // uses the first slot, so everyone after waits
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut handles = Vec::new();
        for n in 0..3 {
            let (scheduler, order) = (scheduler.clone(), order.clone());
            handles.push(std::thread::spawn(move || {
                let _p = priority(Priority::Bulk);
                scheduler.wait("site", GAP);
                order.lock().unwrap().push(format!("bulk{n}"));
            }));
        }
        std::thread::sleep(Duration::from_millis(30)); // the bulk requests are queued
        {
            let (scheduler, order) = (scheduler.clone(), order.clone());
            handles.push(std::thread::spawn(move || {
                let _p = priority(Priority::Interactive);
                scheduler.wait("site", GAP);
                order.lock().unwrap().push("person".to_owned());
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        let order = order.lock().unwrap();
        assert_eq!(
            order.first().map(String::as_str),
            Some("person"),
            "the person's request went first: {order:?}"
        );
        assert_eq!(order.len(), 4);
    }

    #[test]
    fn an_interactive_request_gives_up_when_the_source_is_blocked_for_long() {
        let scheduler = Scheduler::new();
        scheduler.wait("site", GAP);
        scheduler.outcome("site", true, Some(Duration::from_secs(30)));
        let started = Instant::now();
        let busy = {
            let _p = priority(Priority::Interactive);
            scheduler.wait_for_person("site", GAP).unwrap_err()
        };
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "it did not wait the block out"
        );
        assert!(busy.retry_in > Duration::from_secs(20));
        // A request that is not for the person would have waited (not run here: it would wait half a minute).
        let status = scheduler.status();
        assert_eq!(status["sources"][0]["state"], "slowed");
        assert_eq!(
            status["sources"][0]["waiting"], 0,
            "the busy request left the queue"
        );
    }

    #[test]
    fn status_tells_ok_slowed_and_down_apart() {
        let scheduler = Scheduler::new();
        scheduler.wait("a", GAP);
        scheduler.outcome("a", false, None);
        scheduler.wait("b", GAP);
        scheduler.outcome("b", true, Some(Duration::from_secs(1)));
        scheduler.wait("c", GAP);
        for _ in 0..3 {
            scheduler.outcome("c", true, Some(Duration::from_secs(1)));
        }
        let status = scheduler.status();
        let states: Vec<(&str, &str)> = status["sources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| (s["source"].as_str().unwrap(), s["state"].as_str().unwrap()))
            .collect();
        assert_eq!(states, [("a", "ok"), ("b", "slowed"), ("c", "down")]);
        assert!(status["sources"][0]["last_ok_seconds_ago"].is_number());
        assert!(status["sources"][2]["retry_in_seconds"].as_u64().unwrap() <= 1);
    }

    #[test]
    fn bulk_work_steps_aside_just_after_an_interactive_request() {
        let scheduler = Scheduler::with_step_aside(Duration::from_secs(2));
        {
            let _p = priority(Priority::Interactive);
            scheduler.wait("site", Duration::from_millis(10));
        }
        let started = Instant::now();
        // Run the bulk request on a helper thread so the test can look at the clock without waiting ten seconds.
        let scheduler = Arc::new(scheduler);
        let waiter = {
            let scheduler = scheduler.clone();
            std::thread::spawn(move || {
                let _p = priority(Priority::Bulk);
                scheduler.wait("site", Duration::from_millis(10));
            })
        };
        std::thread::sleep(Duration::from_millis(600));
        assert!(
            !waiter.is_finished(),
            "bulk work should still be standing aside after {:?}",
            started.elapsed()
        );
        // A visible request is not held back.
        let visible = Instant::now();
        scheduler.wait("site", Duration::from_millis(10));
        assert!(visible.elapsed() < Duration::from_secs(1));
        // The helper goes on standing aside for the rest of its two seconds; the test does not wait for it.
        drop(waiter);
    }
}
