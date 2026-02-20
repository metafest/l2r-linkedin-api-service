/**
 * Smart rate limiter that tracks per-session usage and enforces
 * configurable delays between profiles and between individual section calls.
 */
export class RateLimiter {
  private requestTimestamps: number[] = [];
  private lastProfileFetchTime = 0;
  private consecutiveSoftLimits = 0;

  private readonly MAX_REQUESTS_PER_HOUR: number;
  private readonly MIN_PROFILE_GAP_MS: number;
  private readonly MAX_PROFILE_GAP_MS: number;
  private readonly MIN_SECTION_GAP_MS: number;
  private readonly MAX_SECTION_GAP_MS: number;

  constructor(options?: {
    maxRequestsPerHour?: number;
    minProfileGapMs?: number;
    maxProfileGapMs?: number;
    minSectionGapMs?: number;
    maxSectionGapMs?: number;
  }) {
    this.MAX_REQUESTS_PER_HOUR = options?.maxRequestsPerHour ?? 200;
    this.MIN_PROFILE_GAP_MS = options?.minProfileGapMs ?? 8000;
    this.MAX_PROFILE_GAP_MS = options?.maxProfileGapMs ?? 15000;
    this.MIN_SECTION_GAP_MS = options?.minSectionGapMs ?? 2000;
    this.MAX_SECTION_GAP_MS = options?.maxSectionGapMs ?? 4000;
  }

  /**
   * Wait until it's safe to start fetching a new profile.
   * Enforces hourly quota and inter-profile delay.
   */
  async waitForProfileSlot(): Promise<void> {
    this.pruneOldTimestamps();

    if (this.requestTimestamps.length >= this.MAX_REQUESTS_PER_HOUR) {
      const oldest = this.requestTimestamps[0];
      const waitMs = oldest + 3_600_000 - Date.now();
      if (waitMs > 0) {
        console.log(
          `   ⏳ Hourly quota (${this.MAX_REQUESTS_PER_HOUR}) reached. Waiting ${(waitMs / 1000).toFixed(0)}s...`
        );
        await this.sleep(waitMs);
      }
    }

    if (this.lastProfileFetchTime > 0) {
      const elapsed = Date.now() - this.lastProfileFetchTime;
      const gap = this.randomInt(this.MIN_PROFILE_GAP_MS, this.MAX_PROFILE_GAP_MS);
      if (elapsed < gap) {
        const waitMs = gap - elapsed;
        console.log(
          `   ⏳ Inter-profile delay: ${(waitMs / 1000).toFixed(1)}s...`
        );
        await this.sleep(waitMs);
      }
    }

    this.lastProfileFetchTime = Date.now();
  }

  /**
   * Wait before fetching the next section within a single profile.
   */
  async waitForSectionSlot(): Promise<void> {
    const gap = this.randomInt(this.MIN_SECTION_GAP_MS, this.MAX_SECTION_GAP_MS);
    await this.sleep(gap);
  }

  recordRequest(): void {
    this.requestTimestamps.push(Date.now());
  }

  recordSoftLimit(): void {
    this.consecutiveSoftLimits++;
  }

  resetSoftLimits(): void {
    this.consecutiveSoftLimits = 0;
  }

  getSoftLimitCount(): number {
    return this.consecutiveSoftLimits;
  }

  getHourlyUsage(): { used: number; max: number } {
    this.pruneOldTimestamps();
    return {
      used: this.requestTimestamps.length,
      max: this.MAX_REQUESTS_PER_HOUR,
    };
  }

  private pruneOldTimestamps(): void {
    const cutoff = Date.now() - 3_600_000;
    this.requestTimestamps = this.requestTimestamps.filter((t) => t > cutoff);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}
