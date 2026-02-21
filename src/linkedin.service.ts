import fs from 'fs';
import path from 'path';
import { BrowserManager } from './browser-manager';
import { RateLimiter } from './rate-limiter';
import { LinkedInCredentials, ProfileData } from './types';

const GRAPHQL_QUERY_ID =
  'voyagerIdentityDashProfileComponents.7e354263db82a0ad715b25a6346abade';

const URN_QUERY_ID =
  'voyagerIdentityDashProfiles.b5c27c04968c409fc0ed3546575b9b7a';

const ALL_SECTIONS: [string, string][] = [
  ['experience', 'Experience'],
  ['education', 'Education'],
  ['skills', 'Skills'],
  ['certifications', 'Certifications'],
  ['projects', 'Projects'],
  ['volunteering-experiences', 'Volunteering'],
];

export class LinkedInService {
  private browser: BrowserManager;
  private rateLimiter: RateLimiter;
  private credentialsPath: string;
  private ambientTrafficEnabled: boolean;
  private initialized = false;

  private linkedInEmail: string;
  private linkedInPassword: string;

  // In-memory URN cache so we don't re-fetch URNs we already resolved
  private urnCache = new Map<string, string>();

  // Soft rate limit tracking
  private consecutiveEmptySections = 0;
  private static readonly SOFT_LIMIT_THRESHOLD = 2;
  private static readonly MAX_SESSION_REFRESHES_PER_REQUEST = 2;

  constructor(options?: {
    credentialsPath?: string;
    ambientTraffic?: boolean;
    linkedInEmail?: string;
    linkedInPassword?: string;
  }) {
    this.browser = new BrowserManager();
    this.rateLimiter = new RateLimiter();
    this.credentialsPath =
      options?.credentialsPath ||
      path.join(process.cwd(), 'linkedin-credentials.json');
    this.ambientTrafficEnabled = options?.ambientTraffic ?? false;
    this.linkedInEmail = options?.linkedInEmail || process.env.LINKEDIN_EMAIL || '';
    this.linkedInPassword = options?.linkedInPassword || process.env.LINKEDIN_PASSWORD || '';
  }

  /**
   * Initialize the Playwright browser and establish a LinkedIn session.
   * Must be called once before any API operations.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const credentials = this.loadCredentials();
    const cookies = Object.entries(credentials.cookies).map(([name, value]) => ({
      name,
      value: String(value),
      domain: '.linkedin.com',
      path: '/',
    }));

    await this.browser.init({
      cookies,
      headless: process.env.HEADLESS !== 'false',
    });

    this.initialized = true;
  }

  /**
   * Resolve the profile URN for a vanity name.
   * Uses in-memory cache, then credentials file, then LinkedIn API.
   */
  async resolveProfileUrn(vanityName: string): Promise<string> {
    // 1. In-memory cache
    if (this.urnCache.has(vanityName)) {
      return this.urnCache.get(vanityName)!;
    }

    // 2. Credentials file (if same vanity)
    const credentials = this.loadCredentials();
    if (credentials.vanityName === vanityName && credentials.profileUrn) {
      this.urnCache.set(vanityName, credentials.profileUrn);
      return credentials.profileUrn;
    }

    // 3. Fetch from LinkedIn
    console.log(`🔍 Extracting profile URN for: ${vanityName}`);
    const url =
      `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true` +
      `&variables=(memberIdentity:${vanityName})&queryId=${URN_QUERY_ID}`;

    this.rateLimiter.recordRequest();
    const result = await this.browser.makeApiCall(url);

    if (result.error) {
      throw new Error(
        `Failed to extract URN: HTTP ${result.status} ${result.statusText || ''}. Credentials may be expired.`
      );
    }

    const data =
      result.data?.data?.data ||
      result.data?.data ||
      result.data;

    let profileUrn = data?.identityDashProfilesByMemberIdentity?.entityUrn;

    if (!profileUrn) {
      const elements =
        data?.identityDashProfilesByMemberIdentity?.['*elements'];
      if (Array.isArray(elements) && elements.length > 0) {
        profileUrn = elements[0];
      }
    }

    if (!profileUrn) {
      throw new Error(`Could not find profile for vanity name: ${vanityName}`);
    }

    console.log(`   ✓ Found URN: ${profileUrn}`);

    // Persist to cache + file
    this.urnCache.set(vanityName, profileUrn);
    credentials.profileUrn = profileUrn;
    credentials.vanityName = vanityName;
    this.saveCredentials(credentials);

    return profileUrn;
  }

  /**
   * Fetch complete profile data: basic info + all sections.
   */
  async fetchProfileData(vanityName: string): Promise<ProfileData> {
    await this.ensureInitialized();
    await this.rateLimiter.waitForProfileSlot();

    if (this.ambientTrafficEnabled) {
      await this.generateAmbientTraffic();
    }

    const profileUrn = await this.resolveProfileUrn(vanityName);

    console.log(`\n📡 Fetching profile data for: ${vanityName}`);
    console.log(`   Profile URN: ${profileUrn}\n`);

    // Basic profile (REST API)
    console.log('   → Fetching basic profile...');
    this.rateLimiter.recordRequest();
    const basicResult = await this.browser.makeApiCall(
      `https://www.linkedin.com/voyager/api/identity/dash/profiles/${encodeURIComponent(
        profileUrn
      )}?decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfile-76`
    );

    if (basicResult.error) {
      throw new Error(
        `Failed to fetch basic profile: HTTP ${basicResult.status}. Session may be expired.`
      );
    }
    console.log('     ✓ Basic profile loaded');

    // Sections (GraphQL section API, sequentially with soft-limit detection)
    const sectionResults: Record<string, any[]> = {};
    this.consecutiveEmptySections = 0;
    let sessionRefreshesThisRequest = 0;

    for (const [sectionType, label] of ALL_SECTIONS) {
      await this.rateLimiter.waitForSectionSlot();
      console.log(`   → Fetching ${label}...`);

      this.rateLimiter.recordRequest();
      let sectionData = await this.fetchSectionRaw(profileUrn, sectionType);
      let items = this.extractComponentData(sectionData, sectionType);

      // Soft rate limit detection
      if (items.length === 0) {
        this.consecutiveEmptySections++;

        if (
          this.consecutiveEmptySections >= LinkedInService.SOFT_LIMIT_THRESHOLD &&
          sessionRefreshesThisRequest < LinkedInService.MAX_SESSION_REFRESHES_PER_REQUEST &&
          this.linkedInEmail &&
          this.linkedInPassword
        ) {
          console.log(
            `     ⚠ Soft rate limit detected (${this.consecutiveEmptySections} consecutive empty). Refreshing session via login...`
          );

          try {
            await this.refreshSession();
            sessionRefreshesThisRequest++;
            this.consecutiveEmptySections = 0;

            // Retry this section with the fresh session
            console.log(`     ↻ Retrying ${label} with new session...`);
            this.rateLimiter.recordRequest();
            sectionData = await this.fetchSectionRaw(profileUrn, sectionType);
            items = this.extractComponentData(sectionData, sectionType);

            if (items.length > 0) {
              console.log(`     ✓ Retry succeeded: ${items.length} items`);
            } else {
              console.log(`     ⚠ Retry still empty after session refresh`);
            }
          } catch (refreshErr: any) {
            console.log(`     ✗ Session refresh failed: ${refreshErr.message}`);
            console.log(`     ⏳ Falling back to 60s cooldown...`);
            await this.sleep(60_000, 65_000);
          }
        }
      } else {
        this.consecutiveEmptySections = 0;
      }

      sectionResults[sectionType] = items;
      console.log(`     ✓ ${items.length} items`);
    }

    console.log('   ✓ All sections fetched\n');

    const totalSections =
      (sectionResults['experience']?.length || 0) +
      (sectionResults['education']?.length || 0) +
      (sectionResults['skills']?.length || 0) +
      (sectionResults['projects']?.length || 0) +
      (sectionResults['certifications']?.length || 0) +
      (sectionResults['volunteering-experiences']?.length || 0);

    const result: ProfileData = {
      metadata: {
        fetchedAt: new Date().toISOString(),
        profileUrn,
        vanityName,
        apiVersion: 'v2-playwright',
        ...(totalSections === 0
          ? { warning: 'All sections returned empty — possible soft rate limit' }
          : {}),
      } as any,
      basicInfo: this.extractBasicInfo(basicResult.data),
      experience: sectionResults['experience'] || [],
      education: sectionResults['education'] || [],
      skills: sectionResults['skills'] || [],
      projects: sectionResults['projects'] || [],
      certifications: sectionResults['certifications'] || [],
      volunteeringExperiences:
        sectionResults['volunteering-experiences'] || [],
    };

    this.logProfileSummary(result);
    return result;
  }

  /**
   * Fetch a single section for a profile.
   */
  async fetchSingleSection(
    vanityName: string,
    sectionType: string
  ): Promise<any[]> {
    await this.ensureInitialized();

    const profileUrn = await this.resolveProfileUrn(vanityName);

    console.log(`   → Fetching section: ${sectionType}...`);
    this.rateLimiter.recordRequest();
    const data = await this.fetchSectionRaw(profileUrn, sectionType);
    const items = this.extractComponentData(data, sectionType);
    console.log(`   ✓ Got ${items.length} items\n`);
    return items;
  }

  getHourlyUsage() {
    return {
      ...this.rateLimiter.getHourlyUsage(),
      sessionRefreshes: this.browser.getSessionRefreshCount(),
    };
  }

  async shutdown(): Promise<void> {
    await this.browser.close();
    this.initialized = false;
  }

  // ── Private: Session refresh ─────────────────────────────────────────

  private async refreshSession(): Promise<void> {
    const newCreds = await this.browser.refreshSessionViaLogin(
      this.linkedInEmail,
      this.linkedInPassword
    );

    // Persist the fresh cookies to the credentials file
    const credentials = this.loadCredentials();
    credentials.csrfToken = newCreds.csrfToken;
    credentials.cookies = newCreds.cookies;
    this.saveCredentials(credentials);

    console.log('   ✓ Credentials file updated with fresh session\n');
  }

  // ── Private: API calls ──────────────────────────────────────────────

  private async fetchSectionRaw(
    profileUrn: string,
    sectionType: string
  ): Promise<any> {
    const url =
      `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true` +
      `&variables=(profileUrn:${encodeURIComponent(profileUrn)},sectionType:${sectionType},locale:en_US)` +
      `&queryId=${GRAPHQL_QUERY_ID}`;

    const result = await this.browser.makeApiCall(url);

    if (result.error) {
      console.log(
        `   ⚠ ${sectionType} section failed: HTTP ${result.status}`
      );
      return { included: [] };
    }

    return result.data || { included: [] };
  }

  // ── Private: Ambient traffic ────────────────────────────────────────

  private async generateAmbientTraffic(): Promise<void> {
    const actions = [
      async () => {
        console.log('   🌐 Ambient: visiting feed...');
        await this.browser.navigateTo('https://www.linkedin.com/feed/');
        await this.sleep(2000, 4000);
      },
      async () => {
        console.log('   🌐 Ambient: checking notifications...');
        await this.browser.navigateTo(
          'https://www.linkedin.com/notifications/'
        );
        await this.sleep(1500, 3000);
      },
      async () => {
        console.log('   🌐 Ambient: scrolling...');
        await this.browser.scrollPage();
        await this.sleep(1000, 2000);
      },
    ];

    const action = actions[Math.floor(Math.random() * actions.length)];
    await action();
  }

  // ── Private: Data extraction ────────────────────────────────────────

  private extractBasicInfo(response: any): ProfileData['basicInfo'] {
    const data = response?.data || response;
    return {
      firstName: data.firstName || 'N/A',
      lastName: data.lastName || 'N/A',
      publicIdentifier: data.publicIdentifier || 'N/A',
      headline: data.headline || 'N/A',
      summary: data.summary || null,
      location: data.geoLocationName || data.locationName || null,
      profilePicture:
        data.pictureUrls?.[0] ||
        data.profilePictureDisplayImage?.rootUrl ||
        null,
      premium: data.premium || false,
    };
  }

  private extractComponentData(data: any, sectionType: string): any[] {
    const included: any[] = data.included || [];
    const results: any[] = [];

    const pagedListMap = new Map<string, any>();
    const allPagedLists: any[] = [];
    for (const item of included) {
      if (
        item.$type ===
        'com.linkedin.voyager.dash.identity.profile.tetris.PagedListComponent'
      ) {
        allPagedLists.push(item);
        if (item.entityUrn) {
          pagedListMap.set(item.entityUrn, item);
        }
      }
    }

    if (allPagedLists.length === 0) return [];

    // Root PagedList: the one for fsd_profile, not fsd_profilePositionGroup
    const rootPagedList =
      allPagedLists.find(
        (pl: any) =>
          pl.entityUrn?.includes('fsd_profile:') &&
          !pl.entityUrn?.includes('fsd_profilePositionGroup')
      ) || allPagedLists[allPagedLists.length - 1];

    const elements = rootPagedList.components?.elements || [];

    for (const element of elements) {
      const entity = element.components?.entityComponent;
      if (!entity) continue;

      // Check for grouped entries (multiple roles at one company)
      const referencedList = this.findReferencedPagedList(
        entity,
        pagedListMap
      );
      if (
        referencedList &&
        (sectionType === 'experience' ||
          sectionType === 'volunteering-experiences')
      ) {
        const parentCompany =
          this.resolveCompanyName(entity, included) ||
          entity.titleV2?.text?.text ||
          'N/A';
        const nestedElements = referencedList.components?.elements || [];

        for (const nestedEl of nestedElements) {
          const nestedEntity = nestedEl.components?.entityComponent;
          if (!nestedEntity) continue;
          const item = this.extractEntityData(
            nestedEntity,
            sectionType,
            included
          );
          if (item) {
            if (item.company === 'N/A' || item.company === item.title) {
              item.company = parentCompany;
            }
            results.push(item);
          }
        }
      } else {
        const item = this.extractEntityData(entity, sectionType, included);
        if (item) results.push(item);
      }
    }

    return results;
  }

  private findReferencedPagedList(
    entity: any,
    pagedListMap: Map<string, any>
  ): any | null {
    const subComponents = entity.subComponents?.components || [];
    for (const sub of subComponents) {
      const ref = sub.components?.['*pagedListComponent'];
      if (ref && pagedListMap.has(ref)) {
        return pagedListMap.get(ref);
      }
    }
    return null;
  }

  private resolveCompanyName(entity: any, included: any[]): string | null {
    if (entity.image?.attributes) {
      for (const attr of entity.image.attributes) {
        const companyUrn = attr.detailData?.['*companyLogo'];
        if (companyUrn) {
          const co = included.find(
            (item: any) => item.entityUrn === companyUrn
          );
          if (co?.name) return co.name;
        }
      }
    }
    return null;
  }

  private extractEntityData(
    entity: any,
    sectionType: string,
    included: any[]
  ): any {
    const title = entity.titleV2?.text?.text || 'N/A';
    const subtitle = entity.subtitle?.text || 'N/A';
    const caption = entity.caption?.text || 'N/A';
    const metadata = entity.metadata?.text || 'N/A';

    let description: string | null = null;
    const subComponents = entity.subComponents?.components || [];
    for (const sub of subComponents) {
      const textComp =
        sub.components?.fixedListComponent?.components?.[0]?.components
          ?.textComponent;
      if (textComp?.text?.text) {
        description = textComp.text.text;
        break;
      }
    }

    let company = 'N/A';
    if (entity.image?.attributes) {
      for (const attr of entity.image.attributes) {
        const companyUrn = attr.detailData?.['*companyLogo'];
        if (companyUrn) {
          const co = included.find(
            (item: any) => item.entityUrn === companyUrn
          );
          if (co?.name) {
            company = co.name;
            break;
          }
        }
      }
    }

    switch (sectionType) {
      case 'experience':
        return {
          title,
          company: company !== 'N/A' ? company : subtitle,
          duration: caption,
          location: metadata,
          description,
        };
      case 'education':
        return {
          schoolName: title,
          degree: subtitle,
          dates: caption,
          additionalInfo: description,
        };
      case 'skills':
        return {
          name: title,
          endorsements: caption || '0 endorsements',
        };
      case 'projects':
        return {
          title,
          description: description || subtitle,
          date: caption,
        };
      case 'certifications':
        return {
          name: title,
          organization: subtitle,
          issueDate: caption,
        };
      case 'volunteering-experiences':
        return {
          role: title,
          organization: company !== 'N/A' ? company : subtitle,
          duration: caption,
          cause: metadata,
          description,
        };
      default:
        return null;
    }
  }

  // ── Private: Credentials ────────────────────────────────────────────

  private loadCredentials(): LinkedInCredentials {
    if (!fs.existsSync(this.credentialsPath)) {
      throw new Error(
        `Credentials file not found at: ${this.credentialsPath}. ` +
          'Please generate credentials first.'
      );
    }
    return JSON.parse(fs.readFileSync(this.credentialsPath, 'utf-8'));
  }

  private saveCredentials(credentials: LinkedInCredentials): void {
    credentials.lastUpdated = new Date().toISOString();
    try {
      fs.writeFileSync(
        this.credentialsPath,
        JSON.stringify(credentials, null, 2)
      );
    } catch (err: any) {
      // Credentials may be mounted read-only (e.g. Cloud Run secret, Kubernetes secret); in-memory cache still works
      const isReadOnly =
        err?.code === 'EROFS' ||
        err?.code === 'EACCES' ||
        err?.code === 'EPERM' ||
        err?.message?.includes('read-only') ||
        err?.message?.includes('permission denied');
      if (isReadOnly) {
        console.warn(
          '   ⚠ Could not persist credentials (file is read-only or not writable); in-memory session will be used.'
        );
      } else {
        throw err;
      }
    }
  }

  // ── Private: Helpers ────────────────────────────────────────────────

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  private logProfileSummary(result: ProfileData): void {
    console.log('📊 Profile data structured successfully');
    console.log(
      `   Name: ${result.basicInfo.firstName} ${result.basicInfo.lastName}`
    );
    console.log(`   Headline: ${result.basicInfo.headline}`);
    console.log(`   Experience: ${result.experience.length} positions`);
    console.log(`   Education: ${result.education.length} entries`);
    console.log(`   Skills: ${result.skills.length} skills`);
    console.log(`   Projects: ${result.projects.length} projects`);
    console.log(
      `   Certifications: ${result.certifications.length} certifications`
    );
    console.log(
      `   Volunteering: ${result.volunteeringExperiences.length} entries\n`
    );
  }

  private sleep(minMs: number, maxMs: number): Promise<void> {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
