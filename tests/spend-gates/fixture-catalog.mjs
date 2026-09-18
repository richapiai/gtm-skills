// A minimal catalog fixture conforming to _lib/contracts/api-catalog.schema.json.
// These tests code against the catalog SCHEMA, not against the generator's output,
// so they stay independent of _lib/api-catalog.json. Every value here
// is taken from spec/openapi.yaml's x-pricing so the fixture stays truthful.

export const catalog = {
  schema_version: 1,
  generated_at: '2026-08-28T00:00:00.000Z',
  spec_sha256: 'a'.repeat(64),
  spec_version: '1.0.0-fixture',
  endpoints: {
    // flat, deterministic, verifiable
    enrich_company: {
      name: 'enrich_company',
      path: '/api/v1/enrich_company',
      capability_group: 'enrichment',
      pricing: { model: 'flat', credits_per_call: 1, billing_field_present_in_response: true, bounded: true },
      required_request_fields: ['linkedin_url'],
      request_body_required: true,
      bulk_variant: 'enrich_companies_bulk',
      max_batch: 100,
      field_map: { name: 'company_name' },
      field_map_status: 'live_fixture'
    },
    // price outlier, always asks
    phone_finder: {
      name: 'phone_finder',
      path: '/api/v1/phone_finder',
      capability_group: 'email_and_phone',
      pricing: { model: 'flat', credits_per_call: 25, billing_field_present_in_response: true, bounded: true },
      required_request_fields: [],   // KNOWN HAZARD per the schema, not a green light
      request_body_required: true,
      field_map_status: 'TODO_no_usable_example'
    },
    find_personal_email: {
      name: 'find_personal_email',
      path: '/api/v1/find_personal_email',
      capability_group: 'email_and_phone',
      pricing: { model: 'flat', credits_per_call: 5, billing_field_present_in_response: true, bounded: true },
      required_request_fields: [],
      request_body_required: true,
      field_map_status: 'TODO_no_usable_example'
    },
    // per-result, billing field IS in the response -> an actual is readable
    people_search: {
      name: 'people_search',
      path: '/api/v1/people_search',
      capability_group: 'people_search',
      pricing: {
        model: 'per_result', credits_per_result: 0.1, result_count_field: 'numberOfElements',
        billing_field_present_in_response: true, bounded: false
      },
      required_request_fields: [],
      request_body_required: true,
      field_map_status: 'live_fixture'
    },
    // base + per result, unbounded (page only)
    lead_search: {
      name: 'lead_search',
      path: '/api/v1/lead_search',
      capability_group: 'people_search',
      pricing: {
        model: 'base_plus_per_result', credits_base: 10, credits_per_result: 0.5,
        result_count_field: 'elements', billing_field_present_in_response: true, bounded: false
      },
      required_request_fields: [],
      request_body_required: true,
      field_map_status: 'live_fixture'
    },
    // _list_count: the synthetic field that appears in ZERO responses.
    // This is one of the 11 endpoints whose charge can never be verified.
    google_search_scraper_sync: {
      name: 'google_search_scraper_sync',
      path: '/api/v1/google_search_scraper_sync',
      capability_group: 'web_intelligence',
      pricing: {
        model: 'per_result', credits_per_result: 1, result_count_field: '_list_count',
        billing_field_present_in_response: false, bounded: true
      },
      required_request_fields: ['query'],
      request_body_required: true,
      field_map_status: 'live_fixture'
    },
    // bills on totalElements, returns only `elements`
    profile_activities: {
      name: 'profile_activities',
      path: '/api/v1/profile_activities',
      capability_group: 'posts_activity',
      pricing: {
        model: 'per_result', credits_per_result: 2, result_count_field: 'totalElements',
        billing_field_present_in_response: false, bounded: true
      },
      required_request_fields: ['profile_url'],
      request_body_required: true,
      field_map_status: 'live_fixture'
    },
    // disabled: the billing semantics contradict themselves
    post_keyword_search: {
      name: 'post_keyword_search',
      path: '/api/v1/post_keyword_search',
      capability_group: 'posts_activity',
      pricing: {
        model: 'per_result', credits_per_result: 6, result_count_field: 'totalElements',
        billing_field_present_in_response: false, bounded: false,
        disabled_by_default: true,
        disabled_reason: 'billing semantics self-contradict; worst case 60,000 credits/call (billing basis undocumented)'
      },
      required_request_fields: ['keyword'],
      request_body_required: true,
      field_map_status: 'live_fixture'
    },
    // pricing we could not resolve — must fail closed, never be guessed
    mystery_endpoint: {
      name: 'mystery_endpoint',
      path: '/api/v1/mystery_endpoint',
      capability_group: 'utilities',
      pricing: { model: 'unknown', billing_field_present_in_response: false, bounded: false },
      required_request_fields: [],
      request_body_required: true,
      field_map_status: 'TODO_no_usable_example'
    }
  }
};

export const ep = (name) => catalog.endpoints[name];
export default catalog;
