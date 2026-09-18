// OUR capability taxonomy, NOT spec `tags`.
//
// Why not tags: the spec's tag axis is incoherent for routing. 68 endpoints carry 15
// tags, 8 of which are singletons (`Funding Data`, `Directory`, `Waterfall`, `Leads`,
// `Posts`, `Activity`, `Social`, `AI`), and the split is semantically wrong for us:
// `email_finder` is tagged `Enrichment` while `email_verifier` — same waterfall family,
// same owning skill — is tagged `Waterfall`. `spec_tag` is kept on every endpoint as a
// tiebreak hint only.
//
// This table is the pack's grouping, written down once. It is data, not derivation:
// a capability group is an editorial decision about which skill should reach for a
// thing, and there is no field in the spec that encodes it.

/** @type {Record<string, string[]>} */
export const CAPABILITY_GROUPS = {
  people_search: [
    'people_search',
    'profile_search',
    'lead_search',
    'linkedin_company_employees_search',
    'linkedin_company_search',
    'linkedin_job_search',
    'geo_id_search',
    'search_reference_data',
  ],
  enrichment: [
    'enrich_profile',
    'enrich_profiles_bulk',
    'enrich_company',
    'enrich_companies_bulk',
    'profile_social_metrics',
    'find_linkedin_url_by_email',
    'find_linkedin_url_by_name',
    'find_website_by_company_name',
    'linkedin_job_detail',
  ],
  email_and_phone: [
    'email_finder',
    'email_verifier',
    'find_personal_email',
    'phone_finder',
    'identify_email_type',
  ],
  posts_activity: [
    'profile_activities',
    'post_activities',
    'post_details',
    'post_keyword_search',
    'linkedin_company_posts',
  ],
  ads_libraries: [
    'linkedin_ad_search',
    'linkedin_ad_details',
    'google_ad_transparency_scraper_sync',
    'meta_ads_library_scraper_sync',
  ],
  maps_directories: [
    'google_maps_places_scraper_keyword',
    'google_maps_places_scraper_sync_using_url',
    'google_maps_reviews_scraper_sync',
    'directory_yellowpages',
  ],
  web_intelligence: [
    'website_intelligence',
    'web_scrape',
    'web_emails',
    'web_meta_tags',
    'web_tech_stack',
    'web_pixels',
    'web_social_links',
    'web_json_ld',
    'web_sitemap',
    'similarweb_scraper_sync',
  ],
  search_trends: ['google_search_scraper_sync', 'search_bing', 'search_google_trends'],
  funding: ['crunchbase_company_scraper_sync'],
  youtube: ['youtube_channel', 'youtube_channel_videos', 'youtube_search', 'youtube_video'],
  ai: ['ai_enrich'],
  social: ['slack_channel_members'],
  utilities: [
    'clean_domain',
    'normalize_company',
    'normalize_phone',
    'normalize_list',
    'remove_whitespace',
    'count_occurrences',
    'extract_urls_emails',
    'encode_uri',
    'format_datetime',
    'find_redirect',
    'find_sitemap_urls',
    'predict_gender',
    'distribute_leads',
  ],
};

/** Every group name the frozen schema's enum allows, in stable display order. */
export const GROUP_ORDER = Object.keys(CAPABILITY_GROUPS);

/** name -> group, built once from the table above. */
const INDEX = new Map();
for (const [group, names] of Object.entries(CAPABILITY_GROUPS)) {
  for (const n of names) {
    if (INDEX.has(n)) throw new Error(`taxonomy: ${n} appears in two groups`);
    INDEX.set(n, group);
  }
}

// Provisional rules for endpoints the API ships AFTER this table was written. Measured
// churn is 15 new endpoints per 4 months, so "crash on unknown" would wedge the build
// roughly monthly. A provisional group plus a loud warning is the fail-open that keeps
// the catalog generating; `richapi-catalog-gen` reports every provisional assignment.
const PROVISIONAL_RULES = [
  [/^youtube_/, 'youtube'],
  [/^web_|^website_|scraper_sync$/, 'web_intelligence'],
  [/^google_maps_|^directory_/, 'maps_directories'],
  [/_ads?_|^linkedin_ad_/, 'ads_libraries'],
  [/^enrich_|^find_linkedin_url|^find_website/, 'enrichment'],
  [/email|phone/, 'email_and_phone'],
  [/^post_|_posts$|_activities$/, 'posts_activity'],
  [/_search$|^search_/, 'people_search'],
  [/^normalize_|^clean_|^remove_|^count_|^extract_|^encode_|^format_/, 'utilities'],
  [/^ai_/, 'ai'],
];

/**
 * @param {string} name operationId
 * @returns {{group: string, provisional: boolean}}
 */
export function capabilityGroupFor(name) {
  const known = INDEX.get(name);
  if (known) return { group: known, provisional: false };
  for (const [re, group] of PROVISIONAL_RULES) {
    if (re.test(name)) return { group, provisional: true };
  }
  return { group: 'utilities', provisional: true };
}

/** Endpoints in the table that the current spec no longer ships. */
export function taxonomyOrphans(specNames) {
  const present = new Set(specNames);
  return [...INDEX.keys()].filter((n) => !present.has(n)).sort();
}
