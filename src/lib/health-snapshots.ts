/**
 * Health snapshot types and pure evaluation logic — Stage 18.
 *
 * A "health snapshot" is a point-in-time capture of a provider metric
 * (campaign analytics, domain aggregate, or inbox state) persisted to the DB.
 * Over time, snapshots form a time-series that enables regression detection.
 *
 * ── Three entity types ────────────────────────────────────────────────────────
 *
 *   Campaign  → sends, opens, replies, bounces (from getCampaignHealth)
 *   Domain    → inbox count, healthy count, blocked count (from getDomainHealth)
 *   Inbox     → warmup status, SMTP/IMAP, reputation (from getInboxHealth)
 *
 * ── Baseline semantics ────────────────────────────────────────────────────────
 *
 * The FIRST snapshot for a given (client, entity) is the baseline (is_baseline=true).
 * All subsequent snapshots are compared to the baseline to detect regressions.
 * The baseline is determined at write time by the DB layer — see health-snapshots.ts.
 *
 * ── Threshold labelling ───────────────────────────────────────────────────────
 *
 * Every numeric threshold in this module is labelled INITIAL_HYPOTHESIS_NOT_VALIDATED.
 * None have been validated against campaign outcome data.
 * They are intentionally conservative starting points.
 *
 * ── Pure functions ────────────────────────────────────────────────────────────
 *
 * All functions in this module are pure — no I/O, no DB calls, no side effects.
 * DB read/write is in src/db/health-snapshots.ts.
 */

// ── Campaign health snapshot ───────────────────────────────────────────────────

export interface CampaignHealthSnapshot {
  id:                 string;
  clientId:           string;
  /** FK → campaigns(id). Cascade-deleted with the campaign. */
  campaignId:         string;
  /** campaigns.platform value — matches OutreachProviderId. */
  platform:           string;
  /** Provider's own campaign ID (campaigns.platform_campaign_id). */
  platformCampaignId: string;
  /** ISO timestamp of when this snapshot was taken. */
  takenAt:            string;
  /** True only for the first snapshot per (clientId, campaignId). */
  isBaseline:         boolean;
  /** Provider-reported campaign status at snapshot time. Null if not available. */
  campaignStatus:     string | null;
  sentCount:          number;
  openCount:          number;
  clickCount:         number;
  replyCount:         number;
  bounceCount:        number;
  unsubscribeCount:   number;
  /** Open rate 0–100. Null when sentCount = 0 (no denominator). */
  openRatePct:        number | null;
  /** Reply rate 0–100. Null when sentCount = 0. */
  replyRatePct:       number | null;
  /** Hard bounce rate 0–100. Null when sentCount = 0. */
  bounceRatePct:      number | null;
}

// ── Domain health snapshot ────────────────────────────────────────────────────

export interface DomainHealthSnapshot {
  id:                 string;
  clientId:           string;
  /** "smartlead" | "instantly" | "plusvibe" */
  provider:           string;
  domain:             string;
  takenAt:            string;
  isBaseline:         boolean;
  /** Total inboxes on this domain registered with the provider. */
  inboxCount:         number;
  /** Inboxes where smtp_ok = true AND imap_ok = true. */
  healthyInboxCount:  number;
  /** Inboxes currently blocked from warmup. */
  blockedInboxCount:  number;
}

// ── Inbox health snapshot ─────────────────────────────────────────────────────

export interface InboxHealthSnapshot {
  id:               string;
  clientId:         string;
  provider:         string;
  platformInboxId:  string;
  /** The sending email address (e.g. "name@domain.com"). Informational only. */
  inboxEmail:       string | null;
  takenAt:          string;
  isBaseline:       boolean;
  /** Warmup status: "active" | "inactive" | "paused" | "unknown". */
  warmupStatus:     string | null;
  /** Reputation tier: "excellent" | "good" | "fair" | "poor" | "unknown". */
  warmupReputation: string | null;
  smtpOk:           boolean | null;
  imapOk:           boolean | null;
  isWarmupBlocked:  boolean | null;
  dailySendLimit:   number | null;
  dailySentCount:   number | null;
  /** Provider tags on this inbox (e.g. team/region tags in Smartlead). */
  tags:             string[];
}

// ── Delta types ───────────────────────────────────────────────────────────────

export interface CampaignHealthDelta {
  baseline:              CampaignHealthSnapshot;
  current:               CampaignHealthSnapshot;
  /** Absolute increase in sent count from baseline. */
  sentDelta:             number;
  /** Percentage-point change in open rate. Null if either snapshot lacks the value. */
  openRateDelta:         number | null;
  /** Percentage-point change in reply rate. Negative = dropped. */
  replyRateDelta:        number | null;
  /** Percentage-point change in bounce rate. Positive = got worse. */
  bounceRateDelta:       number | null;
}

// ── Health evaluation ─────────────────────────────────────────────────────────

export interface HealthConcern {
  code:    string;
  message: string;
}

export interface HealthEvaluation {
  isHealthy: boolean;
  /** Non-empty when isHealthy = false. Each entry describes one concern. */
  concerns:  HealthConcern[];
}

// ── Thresholds ────────────────────────────────────────────────────────────────

/**
 * Bounce rate at or above this percentage is a health concern.
 * INITIAL_HYPOTHESIS_NOT_VALIDATED — industry guidance varies (2–5%);
 * 3% is a conservative starting point.
 */
export const BOUNCE_RATE_WARN_PCT = 3.0;

/**
 * If reply rate drops more than this many percentage points from baseline,
 * flag as a health concern.
 * INITIAL_HYPOTHESIS_NOT_VALIDATED — depends heavily on ICP, sequence, and timing.
 */
export const REPLY_RATE_DROP_WARN_PCT = 2.0;

/**
 * If more than this fraction of a domain's inboxes are warmup-blocked,
 * flag as a health concern.
 * INITIAL_HYPOTHESIS_NOT_VALIDATED — 25% blocked is a rough threshold.
 */
export const INBOX_BLOCK_RATE_WARN_PCT = 25.0;

// ── Pure functions ────────────────────────────────────────────────────────────

/**
 * Compute the delta between a baseline and a current campaign health snapshot.
 * Pure — no DB access.
 */
export function computeCampaignHealthDelta(
  baseline: CampaignHealthSnapshot,
  current:  CampaignHealthSnapshot,
): CampaignHealthDelta {
  return {
    baseline,
    current,
    sentDelta:       current.sentCount  - baseline.sentCount,
    openRateDelta:   rateDelta(baseline.openRatePct,   current.openRatePct),
    replyRateDelta:  rateDelta(baseline.replyRatePct,  current.replyRatePct),
    bounceRateDelta: rateDelta(baseline.bounceRatePct, current.bounceRatePct),
  };
}

/**
 * Evaluate campaign health from the current snapshot and optional delta.
 *
 * Checks:
 *   BOUNCE_RATE_HIGH      — current bounce rate ≥ BOUNCE_RATE_WARN_PCT
 *   REPLY_RATE_DROPPED    — reply rate fell > REPLY_RATE_DROP_WARN_PCT pp from baseline
 */
export function evaluateCampaignHealth(
  current: CampaignHealthSnapshot,
  delta?:  CampaignHealthDelta,
): HealthEvaluation {
  const concerns: HealthConcern[] = [];

  if (current.bounceRatePct !== null && current.bounceRatePct >= BOUNCE_RATE_WARN_PCT) {
    concerns.push({
      code:    "BOUNCE_RATE_HIGH",
      message: `Bounce rate ${current.bounceRatePct}% ≥ ${BOUNCE_RATE_WARN_PCT}% threshold — INITIAL_HYPOTHESIS_NOT_VALIDATED`,
    });
  }

  if (
    delta &&
    delta.replyRateDelta !== null &&
    delta.replyRateDelta < -REPLY_RATE_DROP_WARN_PCT
  ) {
    concerns.push({
      code:    "REPLY_RATE_DROPPED",
      message: `Reply rate dropped ${Math.abs(delta.replyRateDelta).toFixed(1)}pp from baseline — INITIAL_HYPOTHESIS_NOT_VALIDATED`,
    });
  }

  return { isHealthy: concerns.length === 0, concerns };
}

/**
 * Evaluate domain health from the current snapshot.
 *
 * Checks:
 *   INBOX_BLOCK_RATE_HIGH — blocked inbox fraction ≥ INBOX_BLOCK_RATE_WARN_PCT
 *   NO_HEALTHY_INBOXES    — healthyInboxCount = 0 with at least one inbox
 */
export function evaluateDomainHealth(current: DomainHealthSnapshot): HealthEvaluation {
  const concerns: HealthConcern[] = [];

  if (current.inboxCount > 0) {
    const blockPct = (current.blockedInboxCount / current.inboxCount) * 100;
    if (blockPct >= INBOX_BLOCK_RATE_WARN_PCT) {
      concerns.push({
        code:    "INBOX_BLOCK_RATE_HIGH",
        message: `${current.blockedInboxCount}/${current.inboxCount} inboxes warmup-blocked (${blockPct.toFixed(1)}% ≥ ${INBOX_BLOCK_RATE_WARN_PCT}% threshold) — INITIAL_HYPOTHESIS_NOT_VALIDATED`,
      });
    }

    if (current.healthyInboxCount === 0) {
      concerns.push({
        code:    "NO_HEALTHY_INBOXES",
        message: `No healthy inboxes (smtp+imap ok) on domain ${current.domain}`,
      });
    }
  }

  return { isHealthy: concerns.length === 0, concerns };
}

/**
 * Evaluate inbox health from the current snapshot.
 *
 * Checks:
 *   SMTP_FAILING         — smtpOk = false
 *   IMAP_FAILING         — imapOk = false
 *   WARMUP_BLOCKED       — isWarmupBlocked = true
 *   POOR_REPUTATION      — warmupReputation = "poor"
 */
export function evaluateInboxHealth(current: InboxHealthSnapshot): HealthEvaluation {
  const concerns: HealthConcern[] = [];

  if (current.smtpOk === false) {
    concerns.push({ code: "SMTP_FAILING", message: "SMTP connection is failing for this inbox" });
  }
  if (current.imapOk === false) {
    concerns.push({ code: "IMAP_FAILING", message: "IMAP connection is failing for this inbox" });
  }
  if (current.isWarmupBlocked === true) {
    concerns.push({ code: "WARMUP_BLOCKED", message: "Inbox warmup is currently blocked" });
  }
  if (current.warmupReputation === "poor") {
    concerns.push({ code: "POOR_REPUTATION", message: "Inbox warmup reputation is 'poor'" });
  }

  return { isHealthy: concerns.length === 0, concerns };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function rateDelta(baseline: number | null, current: number | null): number | null {
  if (baseline === null || current === null) return null;
  // Round to 1 decimal — rate values are already 1-decimal precision
  return Math.round((current - baseline) * 10) / 10;
}
