use chrono::NaiveDateTime;

/// One captioned frame from a day, as fed to the daily summary.
#[derive(Debug, Clone, PartialEq)]
pub struct Observation {
    pub captured_at: NaiveDateTime,
    pub caption: String,
}

/// Pick at most `limit` observations spread across the day.
///
/// `observations` must be sorted by `captured_at` ascending (the query that
/// produces them orders that way).
///
/// Taking the last `limit` instead — the previous behaviour — summarised only
/// the tail of the day, and because photos arrive in bursts around one scene
/// it fed the model near-identical lines, which is what made the summary read
/// as the same sentence twice. Here the covered span is split into `limit`
/// equal time buckets and one observation is taken from each, so morning and
/// evening are both represented. Remaining slots are then filled by walking
/// the buckets again in time order, so a day whose activity clusters into a
/// few hours still yields `limit` lines rather than a handful.
pub fn select_observations(observations: &[Observation], limit: usize) -> Vec<&Observation> {
    if limit == 0 {
        return Vec::new();
    }
    if observations.len() <= limit {
        return observations.iter().collect();
    }

    let first = observations[0].captured_at;
    let last = observations[observations.len() - 1].captured_at;
    let span = (last - first).num_seconds().max(1);

    let mut buckets: Vec<Vec<&Observation>> = vec![Vec::new(); limit];
    for observation in observations {
        let offset = (observation.captured_at - first).num_seconds().clamp(0, span);
        // `span + 1` keeps the final observation inside the last bucket
        // instead of overflowing into a `limit`-th one.
        let index = (offset as i128 * limit as i128 / (span as i128 + 1)) as usize;
        buckets[index.min(limit - 1)].push(observation);
    }

    let mut selected: Vec<&Observation> = Vec::with_capacity(limit);
    let mut round = 0;
    while selected.len() < limit {
        let mut took_any = false;
        for bucket in &buckets {
            if let Some(observation) = bucket.get(round) {
                selected.push(observation);
                took_any = true;
                if selected.len() == limit {
                    break;
                }
            }
        }
        if !took_any {
            break;
        }
        round += 1;
    }

    selected.sort_by_key(|observation| observation.captured_at);
    selected
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn observation(hour: u32, minute: u32, caption: &str) -> Observation {
        Observation {
            captured_at: NaiveDate::from_ymd_opt(2026, 8, 23)
                .unwrap()
                .and_hms_opt(hour, minute, 0)
                .unwrap(),
            caption: caption.to_string(),
        }
    }

    #[test]
    fn keeps_everything_below_the_limit() {
        let day = vec![observation(1, 0, "a"), observation(20, 0, "b")];
        let picked = select_observations(&day, 25);
        assert_eq!(picked.len(), 2);
        assert_eq!(picked[0].caption, "a");
        assert_eq!(picked[1].caption, "b");
    }

    #[test]
    fn empty_limit_selects_nothing() {
        let day = vec![observation(1, 0, "a")];
        assert!(select_observations(&day, 0).is_empty());
    }

    #[test]
    fn covers_the_morning_when_the_evening_is_busier() {
        // 5 morning frames, then 40 evening frames: the tail-slice behaviour
        // would have dropped the morning entirely.
        let mut day: Vec<Observation> = (0..5)
            .map(|i| observation(1, i, &format!("morning {i}")))
            .collect();
        day.extend((0..40).map(|i| observation(20, i, &format!("evening {i}"))));

        let picked = select_observations(&day, 10);
        assert_eq!(picked.len(), 10);
        assert!(
            picked.iter().any(|o| o.caption.starts_with("morning")),
            "morning must survive: {:?}",
            picked.iter().map(|o| &o.caption).collect::<Vec<_>>()
        );
        assert!(picked.iter().any(|o| o.caption.starts_with("evening")));
    }

    #[test]
    fn fills_the_limit_and_stays_in_time_order() {
        // Everything inside one hour: buckets are unevenly filled, so the
        // fill pass has to top the selection up to the limit.
        let day: Vec<Observation> = (0..60)
            .map(|i| observation(14, i, &format!("frame {i}")))
            .collect();

        let picked = select_observations(&day, 25);
        assert_eq!(picked.len(), 25);
        let times: Vec<_> = picked.iter().map(|o| o.captured_at).collect();
        let mut sorted = times.clone();
        sorted.sort();
        assert_eq!(times, sorted, "selection must stay chronological");
        sorted.dedup();
        assert_eq!(sorted.len(), 25, "no observation may be picked twice");
    }

    #[test]
    fn spreads_across_the_whole_span() {
        let day: Vec<Observation> = (0..24)
            .flat_map(|hour| (0..10).map(move |i| observation(hour, i * 5, "frame")))
            .collect();

        let picked = select_observations(&day, 12);
        assert_eq!(picked.len(), 12);
        let first = picked.first().unwrap().captured_at;
        let last = picked.last().unwrap().captured_at;
        assert!(
            (last - first).num_hours() >= 20,
            "selection should span the day, got {first} .. {last}"
        );
    }
}
