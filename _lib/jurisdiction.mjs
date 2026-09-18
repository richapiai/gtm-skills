// _lib/jurisdiction.mjs — free-text location -> ISO 3166 codes, offline, fail-closed.
//
// THE GAP THIS CLOSES
//
// `/comply` resolves a data subject's jurisdiction from
// `[declared, subject_region, subject_country, phone_country, company_hq_country,
// email_tld]` and stops the run when none of them answers. Those fields are ISO codes.
// The pack's own enrichment does not produce ISO codes: `enrich_profile`'s
// `field_map_keys` (see `_lib/api-catalog.json`) publishes a free-text `location` —
// "Berlin, Germany", "Greater London Area", "San Francisco Bay Area", "Remote".
//
// So a typical prospect list (name, company, domain, linkedin_url) resolved NOTHING,
// enriching it resolved nothing either, and every row stopped. The operator found out
// after paying for the enrichment.
//
// This module is the missing hop, and only that hop: free text in, an ISO 3166-1
// alpha-2 country (plus an ISO 3166-2 subdivision when the text pins one) out. It
// decides nothing about compliance. `/comply`'s gate table is untouched.
//
// THE ONE RULE THAT SHAPES EVERYTHING BELOW
//
// A WRONG country is far worse than an unresolved one. An unresolved row stops — the
// operator adds a column and re-runs. A row mislabelled `US` skips GDPR entirely and
// nobody ever finds out. So every judgement call here is biased toward refusing:
//
//   * Two-letter tokens are NEVER interpreted. "San Francisco, CA" resolves nothing.
//     `CA` is Canada as an ISO 3166-1 code and California as a US state abbreviation,
//     and free text does not say which — the exact confusion `/comply` already warns
//     about. `UK`, `USA`, `U.S.` and `U.K.` are the named exceptions: they are not
//     ISO 3166-1 alpha-2 codes that collide with a subdivision abbreviation.
//   * Contradictory evidence never picks a winner. "Vancouver, Canada / London, United
//     Kingdom" yields the ambiguity result, not one of the two.
//   * A place name shared across covered countries (London, Paris, Berlin, Georgia,
//     Ontario) resolves ONLY when something else in the same string pins the country.
//     Alone it yields the ambiguity result, naming its candidates.
//   * Anything not in the tables below is an explicit null. There is no fallback
//     inference and no network call, so an unlisted region cannot be guessed at.
//
// COVERAGE BOUNDARY — read this before trusting a null
//
// Full ISO 3166-1 is roughly 250 countries. This table carries 39, chosen to be the
// set `/comply` can actually act on plus the markets an English-language pack sells
// into: the 31 countries in comply's own `gdpr` list, `CA` (CASL), `US` (CCPA/CPRA),
// and CH, AU, NZ, IN, SG, ZA — which have no rule set in `/comply` and therefore still
// stop, but stop as "no rule set for ZA" rather than as "unknown". A country outside
// those 39 returns `not_found`. That is a stated limit, not a bug: a half-checked
// 250-row table would be a licence to mislabel, and mislabelling is the failure mode
// this file exists to prevent.
//
// Subdivisions are carried for the US states (except Georgia, which is also a
// country and therefore lives in AMBIGUOUS), the District of Columbia, Canada's
// provinces and territories (except Ontario, also a Californian city, same reason),
// and the European and Australian regions that appear in LinkedIn location strings.
// Cities are the smallest table and the least trusted one — see CITY_TABLE.
//
// SHAPE
//
// Every return value is a dual contract (`_lib/dual-contract.schema.json`):
// `{ result, confidence, reasoning, source }` with exactly one explicit-null enum.
// This module derives its answers from the tables in this file, not from a model, so
// nothing it returns is `ai_inferred` and `storeLlmResult` is not its storage path.
// It borrows the shape because the pack has exactly one way to say "no answer" and a
// second one would be a second convention.
//
// Node >= 18.20.8, ESM, zero dependencies, no network, no credits.

// ---------------------------------------------------------------------------
// Text folding
// ---------------------------------------------------------------------------

// Characters NFD does not decompose. "München" folds via NFD; "Ærø" and "Łódź" do not.
const CHAR_FOLD = new Map([
  ['ß', 'ss'], ['ø', 'o'], ['æ', 'ae'], ['œ', 'oe'], ['đ', 'd'],
  ['ð', 'd'], ['þ', 'th'], ['ł', 'l'], ['ı', 'i'],
]);

/**
 * Fold free text to a comparison form: lowercase, diacritics removed, every run of
 * non-alphanumerics collapsed to one space. `"Île-de-France"` -> `"ile de france"`.
 */
export function foldText (value) {
  const decomposed = String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  let out = '';
  for (const ch of decomposed) out += CHAR_FOLD.get(ch) ?? ch;
  return out.replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Split a location string into the comma-ish parts a person actually types. */
export function locationParts (value) {
  return String(value ?? '')
    .split(/[,;/|\n\r·•]+/)
    .map((p) => ({ raw: p.trim(), folded: foldText(p) }))
    .filter((p) => p.folded !== '');
}

// ---------------------------------------------------------------------------
// Countries — the 39 in the coverage boundary above
// ---------------------------------------------------------------------------
//
// Endonyms are included only where they are unambiguous in folded form. Iceland's
// own name for itself, "Ísland", folds to "island" and would then claim every "Long
// Island" and "Rhode Island" on the list, so it is deliberately absent.

export const COUNTRY_ALIASES = Object.freeze({
  AT: ['Austria', 'Österreich', 'Oesterreich'],
  BE: ['Belgium', 'Belgique', 'België', 'Belgie'],
  BG: ['Bulgaria'],
  HR: ['Croatia', 'Hrvatska'],
  CY: ['Cyprus'],
  CZ: ['Czechia', 'Czech Republic', 'Česko', 'Ceska republika'],
  DK: ['Denmark', 'Danmark'],
  EE: ['Estonia', 'Eesti'],
  ES: ['Spain', 'España', 'Espana'],
  FI: ['Finland', 'Suomi'],
  FR: ['France'],
  DE: ['Germany', 'Deutschland'],
  GR: ['Greece', 'Hellas', 'Elláda', 'Ellada'],
  HU: ['Hungary', 'Magyarország', 'Magyarorszag'],
  IE: ['Ireland', 'Republic of Ireland', 'Éire', 'Eire'],
  IS: ['Iceland'],
  IT: ['Italy', 'Italia'],
  LI: ['Liechtenstein'],
  LT: ['Lithuania', 'Lietuva'],
  LU: ['Luxembourg', 'Lëtzebuerg', 'Letzebuerg'],
  LV: ['Latvia', 'Latvija'],
  MT: ['Malta'],
  NL: ['Netherlands', 'The Netherlands', 'Nederland', 'Holland'],
  NO: ['Norway', 'Norge', 'Noreg'],
  PL: ['Poland', 'Polska'],
  PT: ['Portugal'],
  RO: ['Romania', 'România'],
  SE: ['Sweden', 'Sverige'],
  SI: ['Slovenia', 'Slovenija'],
  SK: ['Slovakia', 'Slovensko'],
  GB: ['United Kingdom', 'UK', 'U.K.', 'Great Britain', 'Britain'],

  CA: ['Canada'],
  US: ['United States', 'United States of America', 'USA', 'U.S.A.', 'U.S.'],

  CH: ['Switzerland', 'Schweiz', 'Suisse', 'Svizzera'],
  AU: ['Australia'],
  NZ: ['New Zealand', 'Aotearoa'],
  IN: ['India'],
  SG: ['Singapore'],
  ZA: ['South Africa'],
});

/** The complete set this module will ever name. Anything else is `not_found`. */
export const COVERED_COUNTRIES = Object.freeze(Object.keys(COUNTRY_ALIASES).sort());

// ---------------------------------------------------------------------------
// The assigned ISO 3166-1 alpha-2 codes
// ---------------------------------------------------------------------------
//
// This is NOT a coverage table and never resolves anything. It answers exactly one
// question, which `/comply` asked and nothing could answer: is `JP` a country this
// pack ships no rule set for, or is it a typo in a column?
//
// Those two refusals look identical and have opposite fixes. "Add a subject_country
// column" is the wrong instruction for a row that already carries one — it was the
// instruction a US-WA row got, and the operator had nothing left to add. So the codes
// live here, next to the other ISO tables, and the gate reads them to pick a message.
// Membership here is not coverage: `JP` is a real code and still has no rule set.

const ISO_3166_1 = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF '
  + 'BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR '
  + 'CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE '
  + 'GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR '
  + 'IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA '
  + 'MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL '
  + 'NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC '
  + 'SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO '
  + 'TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));

/** Is this an assigned ISO 3166-1 alpha-2 code? `XX`, `ZZ` and `QQ` are not. */
export function isCountryCode (value) {
  return ISO_3166_1.has(String(value ?? '').trim().toUpperCase());
}

/**
 * The country an ISO 3166-2 subdivision code sits in — `US-WA` -> `US`.
 *
 * A row that says only `US-WA` is not an unlocatable row: the code names its country
 * in its own prefix. Returns `null` for anything that is not a subdivision code of an
 * assigned country, so nothing is invented from a free-text region.
 */
export function countryOfSubdivision (value) {
  const m = /^([A-Z]{2})-([A-Z0-9]{1,3})$/.exec(String(value ?? '').trim().toUpperCase());
  return m && ISO_3166_1.has(m[1]) ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Subdivisions — ISO 3166-2, matched by NAME only
// ---------------------------------------------------------------------------
//
// `code: null` means "this name pins the country but not one subdivision".
// "Washington" is the case that forces the shape: it is a US state and, in a
// location string, just as often the District of Columbia. The country is certain,
// the subdivision is not, and inventing `US-WA` would be a fabricated provenance.

const SUBDIVISION_TABLE = [
  // United States — 49 states, DC, and `Washington` with no subdivision.
  // `Georgia` is absent on purpose; it is a country too, so it is in AMBIGUOUS.
  ['US', 'US-AL', ['Alabama']], ['US', 'US-AK', ['Alaska']], ['US', 'US-AZ', ['Arizona']],
  ['US', 'US-AR', ['Arkansas']], ['US', 'US-CA', ['California']], ['US', 'US-CO', ['Colorado']],
  ['US', 'US-CT', ['Connecticut']], ['US', 'US-DE', ['Delaware']], ['US', 'US-FL', ['Florida']],
  ['US', 'US-HI', ['Hawaii']], ['US', 'US-ID', ['Idaho']], ['US', 'US-IL', ['Illinois']],
  ['US', 'US-IN', ['Indiana']], ['US', 'US-IA', ['Iowa']], ['US', 'US-KS', ['Kansas']],
  ['US', 'US-KY', ['Kentucky']], ['US', 'US-LA', ['Louisiana']], ['US', 'US-ME', ['Maine']],
  ['US', 'US-MD', ['Maryland']], ['US', 'US-MA', ['Massachusetts']], ['US', 'US-MI', ['Michigan']],
  ['US', 'US-MN', ['Minnesota']], ['US', 'US-MS', ['Mississippi']], ['US', 'US-MO', ['Missouri']],
  ['US', 'US-MT', ['Montana']], ['US', 'US-NE', ['Nebraska']], ['US', 'US-NV', ['Nevada']],
  ['US', 'US-NH', ['New Hampshire']], ['US', 'US-NJ', ['New Jersey']], ['US', 'US-NM', ['New Mexico']],
  ['US', 'US-NY', ['New York', 'New York State', 'New York City']],
  ['US', 'US-NC', ['North Carolina']], ['US', 'US-ND', ['North Dakota']], ['US', 'US-OH', ['Ohio']],
  ['US', 'US-OK', ['Oklahoma']], ['US', 'US-OR', ['Oregon']], ['US', 'US-PA', ['Pennsylvania']],
  ['US', 'US-RI', ['Rhode Island']], ['US', 'US-SC', ['South Carolina']],
  ['US', 'US-SD', ['South Dakota']], ['US', 'US-TN', ['Tennessee']], ['US', 'US-TX', ['Texas']],
  ['US', 'US-UT', ['Utah']], ['US', 'US-VT', ['Vermont']], ['US', 'US-VA', ['Virginia']],
  ['US', 'US-WV', ['West Virginia']], ['US', 'US-WI', ['Wisconsin']], ['US', 'US-WY', ['Wyoming']],
  ['US', 'US-DC', ['District of Columbia', 'Washington DC', 'Washington D.C.']],
  ['US', null, ['Washington']],

  // Canada — provinces and territories. `Ontario` is absent on purpose; see AMBIGUOUS.
  ['CA', 'CA-AB', ['Alberta']], ['CA', 'CA-BC', ['British Columbia']],
  ['CA', 'CA-MB', ['Manitoba']], ['CA', 'CA-NB', ['New Brunswick']],
  ['CA', 'CA-NL', ['Newfoundland and Labrador', 'Newfoundland']],
  ['CA', 'CA-NS', ['Nova Scotia']], ['CA', 'CA-NT', ['Northwest Territories']],
  ['CA', 'CA-NU', ['Nunavut']], ['CA', 'CA-PE', ['Prince Edward Island']],
  ['CA', 'CA-QC', ['Quebec', 'Québec']], ['CA', 'CA-SK', ['Saskatchewan']],
  ['CA', 'CA-YT', ['Yukon']],

  // United Kingdom — the four countries, plus the one LinkedIn actually emits.
  ['GB', 'GB-ENG', ['England']], ['GB', 'GB-SCT', ['Scotland']],
  ['GB', 'GB-WLS', ['Wales', 'Cymru']], ['GB', 'GB-NIR', ['Northern Ireland']],
  ['GB', 'GB-LND', ['Greater London', 'London Area']],

  // European regions common in profile locations.
  ['FR', 'FR-IDF', ['Île-de-France', 'Ile de France']],
  ['FR', 'FR-ARA', ['Auvergne-Rhône-Alpes']],
  ['DE', 'DE-BY', ['Bavaria', 'Bayern']],
  ['DE', 'DE-NW', ['North Rhine-Westphalia', 'Nordrhein-Westfalen']],
  ['DE', 'DE-BW', ['Baden-Württemberg']],
  ['DE', 'DE-HE', ['Hesse', 'Hessen']],
  ['ES', 'ES-CT', ['Catalonia', 'Cataluña', 'Catalunya']],
  ['ES', 'ES-MD', ['Community of Madrid', 'Comunidad de Madrid']],
  ['ES', 'ES-PV', ['Basque Country', 'País Vasco', 'Euskadi']],
  ['IT', 'IT-25', ['Lombardy', 'Lombardia']],
  ['IT', 'IT-62', ['Lazio']],
  ['NL', 'NL-NH', ['North Holland', 'Noord-Holland']],
  ['NL', 'NL-ZH', ['South Holland', 'Zuid-Holland']],
  ['IE', 'IE-L', ['Leinster']],
  ['AU', 'AU-NSW', ['New South Wales']], ['AU', 'AU-QLD', ['Queensland']],
  ['AU', 'AU-WA', ['Western Australia']], ['AU', 'AU-SA', ['South Australia']],
  ['AU', 'AU-TAS', ['Tasmania']],
];

// ---------------------------------------------------------------------------
// Cities — the least trusted table, and priced accordingly
// ---------------------------------------------------------------------------
//
// INCLUSION RULE, applied entry by entry: the name is a capital or a leading city of
// a covered country, AND no settlement of comparable prominence in another covered
// country shares the exact name. Every name that fails the second half is in
// AMBIGUOUS instead, not here.
//
// NO US CITY IS LISTED, ever. American place names are overwhelmingly borrowed from
// Europe, so a US city name is the single most likely way to mislabel a European
// subject. A US subject is pinned by a state name or a country token or not at all.
//
// A city-only match resolves at CONFIDENCE.city, which is BELOW
// AUTOFILL_MIN_CONFIDENCE. That is the containment: even if an entry here is wrong,
// it cannot silently populate a country column — it can only be offered to a human.

const CITY_TABLE = [
  ['IS', ['Reykjavík', 'Reykjavik']],
  ['SI', ['Ljubljana', 'Maribor']],
  ['SK', ['Bratislava', 'Košice', 'Kosice']],
  ['LT', ['Vilnius', 'Kaunas']],
  ['LV', ['Rīga', 'Riga']],
  ['EE', ['Tallinn', 'Tartu']],
  ['HR', ['Zagreb', 'Rijeka']],
  ['RO', ['Bucharest', 'București', 'Bucuresti', 'Cluj-Napoca', 'Timișoara', 'Timisoara']],
  ['HU', ['Budapest', 'Debrecen', 'Szeged']],
  ['BG', ['Sofia', 'Plovdiv', 'Varna']],
  ['CY', ['Nicosia', 'Limassol']],
  ['MT', ['Valletta', 'Sliema']],
  ['LU', ['Luxembourg City']],
  ['LI', ['Vaduz']],
  ['BE', ['Brussels', 'Bruxelles', 'Antwerp', 'Antwerpen', 'Ghent', 'Gent', 'Leuven', 'Liège', 'Liege']],
  ['DK', ['Copenhagen', 'København', 'Kobenhavn', 'Aarhus', 'Odense']],
  ['FI', ['Helsinki', 'Espoo', 'Tampere', 'Oulu']],
  ['NO', ['Oslo', 'Bergen', 'Trondheim', 'Stavanger']],
  ['SE', ['Stockholm', 'Gothenburg', 'Göteborg', 'Goteborg', 'Malmö', 'Malmo', 'Uppsala']],
  ['NL', ['The Hague', 'Den Haag', 'Eindhoven', 'Utrecht', 'Groningen', 'Delft', 'Nijmegen']],
  ['DE', ['Munich', 'München', 'Muenchen', 'Cologne', 'Köln', 'Koeln', 'Düsseldorf', 'Duesseldorf',
    'Stuttgart', 'Leipzig', 'Nuremberg', 'Nürnberg', 'Karlsruhe', 'Mannheim', 'Wiesbaden',
    'Dortmund', 'Frankfurt am Main']],
  ['FR', ['Marseille', 'Toulouse', 'Bordeaux', 'Lyon', 'Nantes', 'Strasbourg', 'Lille',
    'Montpellier', 'Rennes', 'Grenoble']],
  ['ES', ['Madrid', 'Barcelona', 'Sevilla', 'Seville', 'Zaragoza', 'Bilbao', 'Málaga', 'Malaga',
    'Murcia', 'Alicante']],
  ['IT', ['Milano', 'Torino', 'Bologna', 'Napoli', 'Palermo', 'Genova', 'Firenze', 'Venezia',
    'Padova', 'Catania']],
  ['PT', ['Lisboa', 'Braga', 'Coimbra']],
  ['PL', ['Warszawa', 'Kraków', 'Krakow', 'Wrocław', 'Wroclaw', 'Gdańsk', 'Gdansk', 'Poznań',
    'Poznan', 'Łódź', 'Lodz', 'Katowice']],
  ['CZ', ['Praha', 'Brno', 'Ostrava']],
  ['AT', ['Wien', 'Graz', 'Salzburg', 'Linz', 'Innsbruck']],
  ['GR', ['Athína', 'Athina', 'Thessaloniki', 'Piraeus']],
  ['IE', ['Galway', 'Limerick']],
  ['CH', ['Zürich', 'Zurich', 'Genève', 'Geneve', 'Basel', 'Bern', 'Lausanne', 'Winterthur']],
  ['GB', ['Edinburgh', 'Glasgow', 'Leeds', 'Liverpool', 'Sheffield', 'Nottingham', 'Cardiff',
    'Belfast', 'Newcastle upon Tyne', 'Leicester', 'Coventry']],
  ['CA', ['Toronto', 'Montreal', 'Montréal', 'Calgary', 'Edmonton', 'Winnipeg', 'Mississauga',
    'Quebec City', 'Saskatoon']],
  ['AU', ['Canberra', 'Adelaide', 'Geelong']],
  ['NZ', ['Auckland', 'Christchurch']],
  ['IN', ['Mumbai', 'Bengaluru', 'Bangalore', 'Hyderabad', 'Chennai', 'Kolkata', 'Pune',
    'Ahmedabad', 'Gurugram', 'Noida']],
  ['ZA', ['Johannesburg', 'Cape Town', 'Pretoria', 'Durban']],
];

// ---------------------------------------------------------------------------
// Ambiguous names — the ones that must never resolve on their own
// ---------------------------------------------------------------------------
//
// Each entry lists the candidate countries the bare name could mean. Two things
// follow from being listed here, and the second is the more useful one:
//
//   1. Alone, the name yields `not_verifiable` and names its candidates. It never
//      picks one.
//   2. When the rest of the string DOES pin a country, the entry is checked against
//      it. "Berlin, Germany" agrees, and the entry then contributes `DE-BE`.
//      "London, Germany" does not agree, and the whole string refuses rather than
//      trusting the country token over a contradiction.
//
// `country` values outside COVERED_COUNTRIES appear here on purpose: `GE` is not a
// country this module resolves, but its existence is exactly why "Georgia" alone
// must not become `US-GA`.

const AMBIGUOUS_TABLE = [
  ['London', [['GB', null], ['CA', 'CA-ON'], ['US', 'US-OH']]],
  ['Paris', [['FR', null], ['US', 'US-TX'], ['CA', 'CA-ON']]],
  ['Berlin', [['DE', 'DE-BE'], ['US', 'US-NH']]],
  ['Dublin', [['IE', null], ['US', 'US-OH']]],
  ['Birmingham', [['GB', null], ['US', 'US-AL']]],
  ['Cambridge', [['GB', null], ['US', 'US-MA'], ['CA', 'CA-ON']]],
  ['Manchester', [['GB', null], ['US', 'US-NH']]],
  ['Hamburg', [['DE', 'DE-HH'], ['US', 'US-NY']]],
  ['Vienna', [['AT', 'AT-9'], ['US', 'US-VA']]],
  ['Athens', [['GR', null], ['US', 'US-GA']]],
  ['Rome', [['IT', null], ['US', 'US-GA']]],
  ['Naples', [['IT', null], ['US', 'US-FL']]],
  ['Milan', [['IT', null], ['US', 'US-MI']]],
  ['Florence', [['IT', null], ['US', 'US-SC']]],
  ['Venice', [['IT', null], ['US', 'US-CA']]],
  ['Toledo', [['ES', null], ['US', 'US-OH']]],
  ['Valencia', [['ES', null], ['US', 'US-CA']]],
  ['Warsaw', [['PL', null], ['US', 'US-IN']]],
  ['Amsterdam', [['NL', 'NL-NH'], ['US', 'US-NY']]],
  ['Rotterdam', [['NL', 'NL-ZH'], ['US', 'US-NY']]],
  ['Lisbon', [['PT', null], ['US', 'US-OH']]],
  ['Prague', [['CZ', null], ['US', 'US-OK']]],
  ['Geneva', [['CH', 'CH-GE'], ['US', 'US-NY']]],
  ['Aberdeen', [['GB', null], ['US', 'US-SD']]],
  ['Bristol', [['GB', null], ['US', 'US-CT']]],
  ['York', [['GB', null], ['US', 'US-PA']]],
  ['Boston', [['GB', null], ['US', 'US-MA']]],
  ['Plymouth', [['GB', null], ['US', 'US-MA']]],
  ['Portsmouth', [['GB', null], ['US', 'US-NH']]],
  ['Oxford', [['GB', null], ['US', 'US-MS']]],
  ['Durham', [['GB', null], ['US', 'US-NC']]],
  ['Hamilton', [['CA', 'CA-ON'], ['NZ', null], ['US', 'US-OH']]],
  ['Victoria', [['CA', 'CA-BC'], ['AU', 'AU-VIC'], ['US', 'US-TX']]],
  ['Perth', [['AU', 'AU-WA'], ['GB', 'GB-SCT']]],
  ['Newcastle', [['GB', null], ['AU', 'AU-NSW']]],
  ['Sydney', [['AU', 'AU-NSW'], ['CA', 'CA-NS']]],
  ['Melbourne', [['AU', 'AU-VIC'], ['US', 'US-FL']]],
  ['Brisbane', [['AU', 'AU-QLD'], ['US', 'US-CA']]],
  ['Wellington', [['NZ', null], ['GB', null], ['US', 'US-FL']]],
  ['Ontario', [['CA', 'CA-ON'], ['US', 'US-CA']]],
  ['Georgia', [['US', 'US-GA'], ['GE', null]]],
];

// ---------------------------------------------------------------------------
// Multi-country regions and non-locations
// ---------------------------------------------------------------------------
//
// "European Union" is the tempting one. It IS a GDPR signal — but this module
// returns countries, not regimes, and "Europe" spans GDPR members and non-members
// alike. Reporting `not_verifiable` with the label stops the run; guessing a country
// from it would be the mislabelling this file exists to prevent.

const MULTI_COUNTRY_REGIONS = [
  'European Union', 'Europe', 'EMEA', 'APAC', 'LATAM', 'Benelux', 'DACH', 'Nordics',
  'Scandinavia', 'Middle East', 'Asia', 'Asia Pacific', 'North America', 'South America',
  'Latin America', 'Africa', 'Central Europe', 'Eastern Europe', 'Western Europe',
  'Southeast Asia', 'Caribbean', 'Oceania',
];

const NON_LOCATIONS = [
  'Remote', 'Fully Remote', 'Remote Work', 'Work From Home', 'Anywhere', 'Worldwide',
  'Global', 'Globally', 'International', 'Distributed', 'Nomad', 'Digital Nomad',
  'Earth', 'Planet Earth', 'Various', 'Multiple Locations', 'Undisclosed', 'Confidential',
  'Hybrid', 'On Site', 'Onsite',
];

// A LinkedIn "area" label: a metropolitan region with no country token in it.
// "San Francisco Bay Area" is the canonical case — it implies a country to a human
// and names none, so it is reported as ambiguous rather than resolved.
const METRO_SHAPE = /(?:^|\s)(?:greater|metropolitan|metro)(?:\s|$)|(?:^|\s)(?:area|region|metroplex)$/;

// ---------------------------------------------------------------------------
// The phrase index
// ---------------------------------------------------------------------------

export const KIND = Object.freeze({
  COUNTRY: 'country_name',
  SUBDIVISION: 'subdivision_name',
  CITY: 'city_name',
  AMBIGUOUS: 'ambiguous_name',
  REGION: 'multi_country_region',
  NON_LOCATION: 'non_location',
  // The two below are NOT phrase kinds and never appear in `phraseIndex()`. They are
  // the basis of a DECLARED-COLUMN read: see `DECLARED_COUNTRY_FIELDS` below.
  COUNTRY_CODE: 'country_code',
  SUBDIVISION_CODE: 'subdivision_code',
});

/**
 * How much a resolution is worth, by the strongest evidence that produced it.
 * A number, not a word — the dual contract has no "high"/"medium"/"low".
 */
export const CONFIDENCE = Object.freeze({
  country_code: 0.99,      // a column NAMED for a country holds an assigned ISO code
  country_name: 0.99,      // the string names the country
  subdivision_code: 0.95,  // a column named for a region holds an ISO 3166-2 code
  subdivision_name: 0.95,  // the string names a region assigned to exactly one country
  city_name: 0.85,         // the string names a city this table believes is unique
  none: 0,                 // every explicit null: there is no country to be sure about
});

/**
 * The floor at or above which a caller may write the resolution into a country
 * column WITHOUT a human looking at it. City-only matches sit below it by design,
 * so the least reliable table can never populate a column on its own.
 */
export const AUTOFILL_MIN_CONFIDENCE = CONFIDENCE.subdivision_name;

/** Bumped when a table changes in a way a stored provenance string should record. */
export const TABLE_VERSION = 1;

function buildPhrases () {
  const out = [];
  const add = (name, kind, data) => {
    const phrase = foldText(name);
    if (phrase) out.push({ phrase, kind, display: name, ...data });
  };
  for (const [code, names] of Object.entries(COUNTRY_ALIASES)) {
    for (const n of names) add(n, KIND.COUNTRY, { country: code, code: null });
  }
  for (const [country, code, names] of SUBDIVISION_TABLE) {
    for (const n of names) add(n, KIND.SUBDIVISION, { country, code });
  }
  for (const [country, names] of CITY_TABLE) {
    for (const n of names) add(n, KIND.CITY, { country, code: null });
  }
  for (const [name, candidates] of AMBIGUOUS_TABLE) {
    add(name, KIND.AMBIGUOUS, { candidates: candidates.map(([country, code]) => ({ country, code })) });
  }
  for (const n of MULTI_COUNTRY_REGIONS) add(n, KIND.REGION, {});
  for (const n of NON_LOCATIONS) add(n, KIND.NON_LOCATION, {});


  // Longest phrase first. "Northern Ireland" must win over "Ireland", "New York"
  // over "York", "Greater London" over "London" — and once a longer phrase has
  // claimed those characters the shorter one cannot also match them.
  out.sort((a, b) => b.phrase.length - a.phrase.length || a.phrase.localeCompare(b.phrase));
  return out;
}

const PHRASES = buildPhrases();

/** Every phrase the tables know, longest first. Exported so tests can audit it. */
export function phraseIndex () { return PHRASES.map((p) => ({ ...p })); }

/**
 * Match one folded part, consuming characters as phrases claim them.
 * Space padding gives word boundaries for free: " york " does not match " new york ".
 */
function matchPart (folded) {
  const padded = ` ${folded} `;
  const taken = new Array(padded.length).fill(false);
  const hits = [];
  for (const p of PHRASES) {
    const needle = ` ${p.phrase} `;
    let from = 0;
    for (;;) {
      const at = padded.indexOf(needle, from);
      if (at === -1) break;
      const start = at + 1;
      const end = at + needle.length - 1;
      let free = true;
      for (let i = start; i < end; i += 1) if (taken[i]) { free = false; break; }
      if (free) {
        for (let i = start; i < end; i += 1) taken[i] = true;
        hits.push({ ...p, at: start });
      }
      from = at + 1;
    }
  }
  return hits.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------
// Inspection — the structural answer, before it is wrapped in a contract
// ---------------------------------------------------------------------------

/**
 * Everything the tables have to say about one location string.
 * @returns {{
 *   input: string, parts: {raw:string, folded:string}[],
 *   hits: object[], countries: string[], regions: string[],
 *   contradictions: object[], metro_parts: string[],
 *   status: 'resolved'|'ambiguous'|'non_location'|'unknown'|'empty',
 *   country: string|null, region: string|null, confidence: number,
 *   evidence: object[], candidates: object[]
 * }}
 */
export function inspectLocation (value) {
  const parts = locationParts(value);
  const hits = [];
  for (let i = 0; i < parts.length; i += 1) {
    for (const h of matchPart(parts[i].folded)) {
      hits.push({ ...h, part_index: i, part: parts[i].raw });
    }
  }

  const base = {
    input: String(value ?? ''), parts, hits,
    countries: [], regions: [], contradictions: [], metro_parts: [],
    status: 'unknown', country: null, region: null,
    confidence: CONFIDENCE.none, evidence: [], candidates: [],
  };

  if (parts.length === 0) return { ...base, status: 'empty' };

  // Evidence that names a country outright.
  const byCountry = new Map();
  const noteCountry = (code, hit, tier) => {
    if (!byCountry.has(code)) byCountry.set(code, { tier: 0, evidence: [] });
    const e = byCountry.get(code);
    e.tier = Math.max(e.tier, tier);
    e.evidence.push(hit);
  };
  for (const h of hits) {
    if (h.kind === KIND.COUNTRY) noteCountry(h.country, h, CONFIDENCE.country_name);
    else if (h.kind === KIND.SUBDIVISION) noteCountry(h.country, h, CONFIDENCE.subdivision_name);
    else if (h.kind === KIND.CITY) noteCountry(h.country, h, CONFIDENCE.city_name);
  }

  const ambiguous = hits.filter((h) => h.kind === KIND.AMBIGUOUS);
  const regionHits = hits.filter((h) => h.kind === KIND.REGION);
  const nonLocation = hits.filter((h) => h.kind === KIND.NON_LOCATION);
  const metroParts = parts.filter((p) => METRO_SHAPE.test(p.folded)).map((p) => p.raw);

  const countries = [...byCountry.keys()].sort();

  // More than one country named: never pick a winner.
  if (countries.length > 1) {
    return {
      ...base,
      countries,
      status: 'ambiguous',
      candidates: countries.map((c) => ({ country: c, code: null })),
      evidence: countries.flatMap((c) => byCountry.get(c).evidence.map(evidenceOf)),
      metro_parts: metroParts,
    };
  }

  if (countries.length === 1) {
    const country = countries[0];
    const { tier, evidence } = byCountry.get(country);

    // An ambiguous name that CANNOT mean the resolved country is a contradiction.
    // "London, Germany" is not a German subject with a sloppy city; it is a row
    // nobody should classify.
    const contradictions = ambiguous.filter((h) => !h.candidates.some((c) => c.country === country));
    if (contradictions.length > 0) {
      return {
        ...base,
        countries, status: 'ambiguous', contradictions,
        candidates: [
          { country, code: null },
          ...contradictions.flatMap((h) => h.candidates),
        ],
        evidence: [...evidence, ...contradictions].map(evidenceOf),
        metro_parts: metroParts,
      };
    }

    // Region: from a named subdivision, or from an ambiguous name the country settled.
    const regionCodes = new Set();
    for (const h of hits) {
      if (h.kind === KIND.SUBDIVISION && h.country === country && h.code) regionCodes.add(h.code);
    }
    for (const h of ambiguous) {
      for (const c of h.candidates) if (c.country === country && c.code) regionCodes.add(c.code);
    }
    const regions = [...regionCodes].sort();

    const settled = ambiguous.filter((h) => h.candidates.some((c) => c.country === country));
    return {
      ...base,
      countries, regions,
      status: 'resolved',
      country,
      // Two different subdivisions in one string pin the country but not the region.
      region: regions.length === 1 ? regions[0] : null,
      confidence: tier,
      evidence: [...evidence, ...settled].map(evidenceOf),
      metro_parts: metroParts,
    };
  }

  // Nothing named a country. Explain WHY, most specific reason first.
  if (ambiguous.length > 0) {
    return {
      ...base,
      status: 'ambiguous',
      candidates: ambiguous.flatMap((h) => h.candidates),
      evidence: ambiguous.map(evidenceOf),
      metro_parts: metroParts,
    };
  }
  if (regionHits.length > 0) {
    return { ...base, status: 'ambiguous', evidence: regionHits.map(evidenceOf), metro_parts: metroParts };
  }
  if (metroParts.length > 0) {
    return { ...base, status: 'ambiguous', metro_parts: metroParts };
  }
  if (nonLocation.length > 0) {
    return { ...base, status: 'non_location', evidence: nonLocation.map(evidenceOf) };
  }
  return { ...base, status: 'unknown' };
}

function evidenceOf (hit) {
  return {
    kind: hit.kind,
    matched: hit.display,
    part: hit.part,
    part_index: hit.part_index,
    maps_to: hit.kind === KIND.AMBIGUOUS
      ? hit.candidates.map((c) => c.code || c.country).join('|')
      : (hit.code || hit.country || null),
  };
}

// ---------------------------------------------------------------------------
// The dual contract
// ---------------------------------------------------------------------------

const list = (arr) => arr.join(', ');

// ---------------------------------------------------------------------------
// Declared columns — where a two-letter token IS readable
// ---------------------------------------------------------------------------
//
// The tables above refuse every two-letter token, because in free text `CA` is Canada
// and California with equal likelihood. A COLUMN NAME removes that ambiguity: a value
// sitting under `subject_country` / `location_country` / `country` is asserted by its
// own header to be a country, and `/comply`'s gate table already reads
// `subject_country` as an ISO 3166-1 alpha-2 code. Refusing to read one here while the
// gate reads it there would be two different answers from one pack.
//
// The same two-letter rule does NOT relax for a region column: `location_state: "CA"`
// is a US state abbreviation, ISO 3166-2 is `US-CA`, and no country can be derived
// from the abbreviation alone. A region column is read only in its full ISO form.
//
// This is also the hop the enrichment gap needed. `enrich_profile` and the bulk path
// write `location_country: "United States"` and `location_state: "Washington"` (see
// `_lib/client.mjs:RESPONSE_MAPS` and `tests/fixtures/live/enrich_profile.json`) —
// NAMES, not codes. A declared column therefore accepts either form: the code short
// circuit below, else the same name tables every other field goes through.

/** Columns whose header asserts the value is a country: a bare ISO code is read. */
export const DECLARED_COUNTRY_FIELDS = Object.freeze([
  'subject_country', 'location_country', 'country',
]);

/** Columns whose header asserts the value is a region: only a full ISO 3166-2 code. */
export const DECLARED_REGION_FIELDS = Object.freeze([
  'subject_region', 'location_state',
]);

function declaredKindOf (field) {
  if (DECLARED_COUNTRY_FIELDS.includes(field)) return 'country';
  if (DECLARED_REGION_FIELDS.includes(field)) return 'region';
  return null;
}

/** An ISO code read out of a declared column, or null to fall through to the tables. */
function readDeclaredCode (raw, kind) {
  const token = raw.trim().toUpperCase();
  const sub = countryOfSubdivision(token);
  if (sub) return { country: sub, region: token, basis: KIND.SUBDIVISION_CODE };
  if (!/^[A-Z]{2}$/.test(token)) {
    // A column HEADED for a country asserts that its value is one, so the whole ISO
    // list is readable here — not just the countries this pack ships rules for.
    // Free text is untouched: `Tokyo, Japan` in a `location` column still resolves to
    // nothing, because there the string is a guess and the header is not a promise.
    // Live 2026-09-17: `subject_country: Japan` refused as "states no country at all",
    // when the honest refusal is "no rule set for JP".
    const named = kind === 'country' ? isoCountryByName(raw) : null;
    return named ? { country: named, region: null, basis: KIND.COUNTRY } : null;
  }
  if (kind !== 'country') return null;             // a bare 2-letter REGION is a state abbrev
  if (!isCountryCode(token)) return null;          // `XX` is not assigned: fail closed
  return { country: token, region: null, basis: KIND.COUNTRY_CODE };
}

/**
 * An assigned ISO country by its English name, from the runtime's own region data.
 *
 * Only ever consulted for a column whose header names a country (see readDeclaredCode).
 * A name the curated tables treat as ambiguous — `Georgia`, `Ontario` — is refused here
 * too, so the careful handling written for those names is never bypassed. A runtime
 * without ICU region data simply has no extra names.
 */
let isoNameIndex = null;
function isoCountryByName (raw) {
  const phrase = foldText(String(raw ?? ''));
  if (!phrase) return null;
  if (isoNameIndex === null) {
    isoNameIndex = new Map();
    try {
      const names = new Intl.DisplayNames(['en'], { type: 'region' });
      for (const code of ISO_3166_1) {
        const label = names.of(code);
        if (!label || label === code) continue;
        const key = foldText(label);
        if (key) isoNameIndex.set(key, code);
      }
    } catch { /* no ICU region data: the curated tables stand alone */ }
  }
  // Anything the phrase index already knows keeps its own kind (ambiguous, city,
  // region, non-location), so this never overrides a considered answer.
  if (PHRASES.some((h) => h.phrase === phrase)) return null;
  return isoNameIndex.get(phrase) ?? null;
}

/**
 * Resolve one free-text location to an ISO country (and subdivision when the text
 * pins one), as a dual contract.
 *
 * `result` is either
 *   `{ country, region, confidence_basis, evidence[] }`  — a real value, or
 *   `not_found` | `not_verifiable` | `not_applicable`    — the one explicit-null enum.
 *
 * `not_found`      nothing in the string is in the coverage tables (or it was empty).
 * `not_verifiable` something is there and it does not pin ONE country: an ambiguous
 *                  place name, contradictory countries, a multi-country region, or a
 *                  metropolitan-area label with no country in it.
 * `not_applicable` the string does not describe a place at all ("Remote").
 *
 * @param {string} value free text, e.g. `enrich_profile`'s `location`
 * @param {{field?: string}} [opts] which input field this came from, for provenance
 * @returns {{result: object|string, confidence: number, reasoning: string, source: string}}
 */
export function resolveLocation (value, { field = 'location', declared = declaredKindOf(field) } = {}) {
  const source = `jurisdiction-table v${TABLE_VERSION} (_lib/jurisdiction.mjs) <- ${field}`;
  const nul = (result, reasoning) => ({ result, confidence: CONFIDENCE.none, reasoning, source });

  // A column whose header names a country or a region may state an ISO code outright.
  // Anything else in such a column falls straight through to the same tables every
  // free-text field uses, so `location_country: "United States"` still resolves.
  const raw = String(value ?? '');
  if (declared && raw.trim()) {
    const hit = readDeclaredCode(raw, declared);
    if (hit) {
      const token = raw.trim().toUpperCase();
      return {
        result: {
          country: hit.country,
          region: hit.region,
          confidence_basis: hit.basis,
          evidence: [{
            kind: hit.basis, matched: token, part: raw.trim(), part_index: 0,
            maps_to: hit.region || hit.country, field,
          }],
        },
        confidence: CONFIDENCE[hit.basis],
        reasoning: `\`${field}\` states the ISO code "${token}", and the column name says which `
          + `kind of code it is, so it is read as ${hit.country}${hit.region ? ` / ${hit.region}` : ''} `
          + 'without consulting the name tables.',
        source,
      };
    }
  }

  const seen = inspectLocation(value);

  if (seen.status === 'empty') {
    return nul('not_found', `\`${field}\` is empty, so there is no location text to resolve.`);
  }
  if (seen.status === 'non_location') {
    const which = list(seen.evidence.map((e) => e.matched));
    return nul('not_applicable',
      `\`${field}\` is "${seen.input}", which names a working arrangement (${which}), not a place. `
      + 'A country cannot be derived from it; ask for one.');
  }
  if (seen.status === 'ambiguous') {
    return nul('not_verifiable', ambiguityReason(seen, field));
  }
  if (seen.status === 'resolved') {
    const basis = seen.evidence.find((e) => e.kind === KIND.COUNTRY)
      || seen.evidence.find((e) => e.kind === KIND.SUBDIVISION)
      || seen.evidence.find((e) => e.kind === KIND.CITY);
    return {
      result: {
        country: seen.country,
        region: seen.region,
        confidence_basis: basis ? basis.kind : KIND.COUNTRY,
        evidence: seen.evidence.map((e) => ({ ...e, field })),
      },
      confidence: seen.confidence,
      reasoning: `"${seen.input}" -> ${seen.country}${seen.region ? ` / ${seen.region}` : ''} `
        + `because ${field} contains ${list(seen.evidence.map((e) => `"${e.matched}" (${e.kind})`))}. `
        + (seen.region ? '' : 'No single subdivision is named, so none is reported. '),
      source,
    };
  }
  return nul('not_found',
    `Nothing in "${seen.input}" matches the coverage tables in _lib/jurisdiction.mjs `
    + `(${COVERED_COUNTRIES.length} countries; US and Canadian cities are deliberately not `
    + 'resolved by name). '
    + (declared === 'region'
      ? `\`${field}\` is a region column, so it is read only as a full ISO 3166-2 code `
        + '(`US-WA`, not `WA` and not `CA`): a bare two-letter abbreviation names no country. '
        + 'Put the full code in it, or state the country in `subject_country`.'
      : declared === 'country'
        ? `\`${field}\` is a country column, so it is read as an ISO 3166-1 alpha-2 code or as `
          + 'a country NAME, and this value is neither an assigned code nor a name in the '
          + 'coverage table. Put an assigned alpha-2 code in `subject_country`.'
        : 'Two-letter tokens are never interpreted in free text, so a state abbreviation '
          + 'resolves nothing. Add a `subject_country` column.'));
}

function ambiguityReason (seen, field) {
  const where = `\`${field}\` is "${seen.input}"`;
  if (seen.contradictions.length > 0) {
    return `${where}, which contradicts itself: it names `
      + `${list(seen.countries)} and also ${list(seen.contradictions.map((h) => `"${h.display}"`))}, `
      + `which cannot be in ${list(seen.countries)}. Refusing rather than trusting one half.`;
  }
  if (seen.countries.length > 1) {
    return `${where}, which names more than one country (${list(seen.countries)}). `
      + 'A jurisdiction is the data subject\'s, and this row does not say which one. '
      + 'Refusing rather than picking a winner.';
  }
  const named = seen.evidence.filter((e) => e.kind === KIND.AMBIGUOUS);
  if (named.length > 0) {
    const candidates = [...new Set(seen.candidates.map((c) => c.code || c.country))].sort();
    return `${where}. ${list(named.map((e) => `"${e.matched}"`))} exists in more than one `
      + `country (${list(candidates)}) and nothing else in the string pins one. `
      + 'A wrong country skips a whole regime, so this refuses instead of guessing.';
  }
  const region = seen.evidence.filter((e) => e.kind === KIND.REGION);
  if (region.length > 0) {
    return `${where}, which names a multi-country region `
      + `(${list(region.map((e) => e.matched))}), not a country. Different countries inside it `
      + 'carry different regimes, so it cannot stand in for one.';
  }
  return `${where}, a metropolitan-area label (${list(seen.metro_parts)}) with no country `
    + 'in it. It may imply one to a reader; it does not state one, and this table will not '
    + 'infer a country from a city cluster.';
}

// ---------------------------------------------------------------------------
// Row-level helper — what `/comply` actually needs
// ---------------------------------------------------------------------------

/**
 * The fields a prospect row might carry a location in, best first.
 *
 * The first five are the columns THIS PACK ACTUALLY WRITES. `_lib/client.mjs` maps
 * `enrich_profile`'s recorded response into `location`, `location_city`,
 * `location_state` and `location_country`, and the last of those holds
 * "United States" — a NAME. `/comply` detects on `subject_country` / `subject_region`
 * and wants ISO codes. Until this list named the enrichment columns, every enriched
 * row still had to be hand-mapped before the gate could read it, which is the whole
 * reason a paid enrichment resolved no jurisdictions at all.
 */
export const DEFAULT_LOCATION_FIELDS = Object.freeze([
  'subject_country', 'subject_region', 'location_country', 'country', 'location_state',
  'subject_location', 'location', 'person_location', 'city', 'geo', 'region_text',
]);

/**
 * Read a row's free-text location fields and propose the ISO columns `/comply`
 * detects on. Nothing is written: this returns a proposal plus the contract that
 * justifies it, and the caller decides.
 *
 * `apply` is true only at or above AUTOFILL_MIN_CONFIDENCE — a city-only match is
 * reported with `apply: false` so a human confirms it. Rows that already carry
 * `subject_country` are left alone: an operator-supplied code outranks this table.
 *
 * @returns {{apply: boolean, columns: object, field: string|null, contract: object}}
 */
/**
 * A subdivision from a REGION column, but only one that agrees with the country the
 * row already resolved to.
 *
 * `location_country: "United States"` + `location_state: "California"` is one row and
 * two columns, and the country column answers first. Dropping the state would lose
 * `US-CA`, which is the difference between a CCPA row and a plain CAN-SPAM one. A
 * region that disagrees with the resolved country is discarded rather than believed:
 * a contradictory row never picks a winner here.
 */
function regionTopUp (row, country, fields) {
  for (const field of fields) {
    if (!DECLARED_REGION_FIELDS.includes(field)) continue;
    const value = row?.[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const c = resolveLocation(value, { field });
    if (typeof c.result === 'object' && c.result.country === country && c.result.region) {
      return c.result.region;
    }
  }
  return null;
}

export function proposeSubjectColumns (row, { fields = DEFAULT_LOCATION_FIELDS } = {}) {
  const existing = typeof row?.subject_country === 'string' ? row.subject_country.trim() : '';
  // An operator-supplied CODE outranks the table. A `subject_country` holding a country
  // NAME does not — `/comply` reads that column as ISO 3166-1 alpha-2 and a name in it
  // resolves nothing — so it falls through to the loop and is resolved like any other
  // declared column.
  if (existing && (isCountryCode(existing) || countryOfSubdivision(existing))) {
    return {
      apply: false, columns: {}, field: null,
      contract: {
        result: 'not_applicable',
        confidence: CONFIDENCE.none,
        reasoning: `The row already declares subject_country "${existing}". An operator-supplied `
          + 'code outranks a table lookup, so nothing is proposed.',
        source: `jurisdiction-table v${TABLE_VERSION} (_lib/jurisdiction.mjs) <- subject_country`,
      },
    };
  }

  let fallback = null;
  for (const field of fields) {
    const value = row?.[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const contract = resolveLocation(value, { field });
    if (typeof contract.result === 'object') {
      const columns = { subject_country: contract.result.country };
      const region = contract.result.region || regionTopUp(row, contract.result.country, fields);
      if (region) columns.subject_region = region;
      return {
        apply: contract.confidence >= AUTOFILL_MIN_CONFIDENCE,
        columns, field, contract,
      };
    }
    // Keep the first field that had SOMETHING to say, so the operator is told why.
    if (!fallback || fallback.contract.result === 'not_found') fallback = { field, contract };
  }

  if (fallback) return { apply: false, columns: {}, field: fallback.field, contract: fallback.contract };
  return {
    apply: false, columns: {}, field: null,
    contract: {
      result: 'not_found',
      confidence: CONFIDENCE.none,
      reasoning: `The row carries no non-empty location field (looked at: ${list(fields)}). `
        + 'Enrichment produces free-text `location`; without it there is nothing to resolve.',
      source: `jurisdiction-table v${TABLE_VERSION} (_lib/jurisdiction.mjs) <- (no field)`,
    },
  };
}

export default {
  foldText, locationParts, inspectLocation, resolveLocation, proposeSubjectColumns,
  phraseIndex, COUNTRY_ALIASES, COVERED_COUNTRIES, CONFIDENCE, AUTOFILL_MIN_CONFIDENCE,
  DEFAULT_LOCATION_FIELDS, DECLARED_COUNTRY_FIELDS, DECLARED_REGION_FIELDS,
  KIND, TABLE_VERSION, isCountryCode, countryOfSubdivision,
};
