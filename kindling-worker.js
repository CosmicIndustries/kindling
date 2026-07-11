addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request));
});

var CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

async function handleRequest(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const query = parseQuery(url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return jsonResponse(healthPayload(query.keys));
    }

    if (url.pathname !== '/jobs') {
      return jsonResponse({ error: 'Use /jobs?q=title&location=city' }, 404);
    }

    const plan = buildSourcePlan(query);
    const { jobs, sources, errors } = await runSourcePlan(plan);
    const filtered = filterJobs(dedupJobs(jobs), query);

    return jsonResponse({
      total: filtered.length,
      sources,
      adzuna_configured:  !!(query.keys.adzuna_app_id && query.keys.adzuna_app_key),
      usajobs_configured: !!(query.keys.usajobs_api_key && query.keys.usajobs_email),
      jooble_configured:  !!query.keys.jooble_api_key,
      errors,
      jobs: filtered,
    });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: CORS });
}

function normalizeQuery(value) {
  const query = (value || '').trim();
  return query === '*' ? '' : query;
}

function parseQuery(url) {
  return {
    q: normalizeQuery(url.searchParams.get('q') || ''),
    location: url.searchParams.get('location') || '',
    country: (url.searchParams.get('country') || 'us').toLowerCase(),
    radius: url.searchParams.get('radius') || '',
    remote: url.searchParams.get('remote') || '',
    type: url.searchParams.get('type') || '',
    keys: {
      adzuna_app_id:  url.searchParams.get('adzuna_app_id')  || '',
      adzuna_app_key: url.searchParams.get('adzuna_app_key') || '',
      usajobs_api_key:url.searchParams.get('usajobs_api_key')|| '',
      usajobs_email:  url.searchParams.get('usajobs_email')  || '',
      jooble_api_key: url.searchParams.get('jooble_api_key') || '',
    },
  };
}

function healthPayload(keys) {
  return {
    ok: true,
    version: '1.8.0',
    note: 'Pass API keys as query params - no env var config needed',
    usage: '/jobs?q=field+technician&location=Brunswick,GA&country=us&radius=50',
    adzuna_configured: !!(keys.adzuna_app_id && keys.adzuna_app_key),
    usajobs_configured: !!(keys.usajobs_api_key && keys.usajobs_email),
    jooble_configured: !!keys.jooble_api_key,
  };
}

function addSource(plan, key, run) {
  plan.push({ key, run });
}

function buildSourcePlan(query) {
  const plan = [];
  const remoteOnly = query.remote === 'remote';
  const localOnly = query.remote === 'local' || query.remote === 'onsite';
  if (!remoteOnly && query.keys.adzuna_app_id && query.keys.adzuna_app_key) {
    addSource(plan, 'adzuna', () => fetchAdzuna(query.q, query.location, query.keys, query.country, query.radius));
  }
  if (!remoteOnly && query.country === 'us' && query.keys.usajobs_api_key && query.keys.usajobs_email) {
    addSource(plan, 'usajobs', () => fetchUSAJobs(query.q, query.location, query.keys));
  }
  if (!remoteOnly && query.keys.jooble_api_key) {
    addSource(plan, 'jooble', () => fetchJooble(query.q, query.location, query.keys, query.radius));
  }
  if (!localOnly && query.country === 'us') {
    addSource(plan, 'jobicy', () => fetchJobicy(query.q));
    addSource(plan, 'himalayas', () => fetchHimalayas(query.q));
    addSource(plan, 'remoteok', () => fetchRemoteOK(query.q));
    addSource(plan, 'graphql', () => fetchGraphQLJobs(query.q));
  }
  if (!remoteOnly && ['de','at','ch','nl','fr','it','es','be','pl'].includes(query.country)) {
    addSource(plan, 'arbeitnow', () => fetchArbeitnow(query.q, query.location));
  }
  return plan;
}

async function runSourcePlan(plan) {
  const settled = await Promise.allSettled(plan.map(s => s.run()));
  const jobs = [];
  const sources = {};
  const errors = {};
  settled.forEach((result, i) => {
    const key = plan[i].key;
    if (result.status === 'fulfilled') {
      const normalized = result.value.map(job => ({
        ...job,
        benefits: Array.isArray(job.benefits) && job.benefits.length ? job.benefits : benefitsFromJob(job),
      }));
      sources[key] = normalized.length;
      jobs.push(...normalized);
      errors[key] = null;
    } else {
      sources[key] = 0;
      errors[key] = String(result.reason);
    }
  });
  return { jobs, sources, errors };
}

function dedupJobs(jobs) {
  const seen = new Set();
  return jobs.filter(j => {
    const key = `${j.title}::${j.company}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const BENEFIT_HINTS = [
  ['health insurance', 'Health'], ['medical insurance', 'Health'], ['medical coverage', 'Health'],
  ['dental', 'Dental'], ['vision', 'Vision'], ['401k', '401(k)'], ['401(k)', '401(k)'],
  ['retirement', 'Retirement'], ['pension', 'Pension'], ['paid time off', 'PTO'], ['pto', 'PTO'],
  ['paid vacation', 'Vacation'], ['paid holiday', 'Paid holidays'], ['sick leave', 'Sick leave'],
  ['life insurance', 'Life insurance'], ['disability insurance', 'Disability'], ['tuition', 'Tuition'],
  ['union', 'Union'], ['stock options', 'Equity'], ['equity', 'Equity'], ['employer match', '401(k) match'],
];

function benefitsFromJob(job) {
  const raw = [job.description, ...(Array.isArray(job.tags) ? job.tags : [])].join(' ').toLowerCase();
  const found = [];
  BENEFIT_HINTS.forEach(([term, label]) => {
    if (raw.includes(term) && !found.includes(label)) found.push(label);
  });
  return found;
}

function filterJobs(jobs, query) {
  const q = query.q.toLowerCase();
  const remoteOnly = query.remote === 'remote';
  const localOnly = query.remote === 'local' || query.remote === 'onsite';
  return jobs.filter(j => {
    if (q && !matchesQuery(j, q)) return false;
    if (remoteOnly && !j.remote) return false;
    if (localOnly && j.remote) return false;
    return true;
  });
}

function matchesQuery(job, q) {
  const haystack = [job.title || '', job.description || '', ...(job.tags || [])].join(' ').toLowerCase();
  const variants = [q];
  const groups = [
    ['it support', 'information technology support', 'technical support', 'desktop support', 'help desk', 'computer support', 'field technician', 'computer technician'],
    ['field tech', 'field technician', 'computer field technician', 'onsite technician'],
    ['network tech', 'network technician', 'network support'],
    ['cyber', 'cybersecurity', 'security analyst'],
  ];
  groups.forEach(group => {
    if (group.some(term => q.includes(term))) variants.push(...group);
  });
  if (variants.some(term => haystack.includes(term))) return true;
  const words = q.split(/\s+/).filter(word => word.length > 2);
  return words.length > 1 && words.every(word => haystack.includes(word));
}

// -- Source fetchers ---------------------------------------------------------

// Adzuna - real US local/onsite listings. Requires env.ADZUNA_APP_ID / ADZUNA_APP_KEY.
async function fetchAdzuna(q, location, keys, country = 'us', radius = '') {
  const appId  = keys.adzuna_app_id;
  const appKey = keys.adzuna_app_key;
  if (!appId || !appKey) return []; // silently skip if not configured
  if (country === 'unsupported') return [];
  const supported = new Set(['us','gb','ca','au','de','fr','nl','it','pl','at','in','sg','nz','br','mx','za']);
  const market = supported.has(country) ? country : 'us';

  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    results_per_page: '30',
    'content-type': 'application/json',
  });
  if (q)        params.set('what', q);
  if (location) params.set('where', location);
  if (radius)   params.set('distance', radius);

  const r = await fetch(`https://api.adzuna.com/v1/api/jobs/${market}/search/1?${params}`);
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json())?.display || ''; } catch {}
    throw new Error(`Adzuna HTTP ${r.status}${detail ? ': ' + detail : ''}`);
  }
  const d = await r.json();

  return (d.results || []).map(j => ({
    id: 'adz_' + j.id,
    title: j.title || '',
    company: j.company?.display_name || 'Unknown',
    location: j.location?.display_name || location || '',
    remote: false,
    type: j.contract_time === 'part_time' ? 'parttime' : 'fulltime',
    salary_min: j.salary_min || null,
    salary_max: j.salary_max || null,
    salary_period: (j.salary_min || j.salary_max) ? 'YEAR' : null,
    description: j.description || '',
    apply_url: j.redirect_url || '',
    posted_at: j.created || null,
    source: 'Adzuna',
    tags: j.category?.label ? [j.category.label] : [],
  }));
}

// USAJobs - real US federal jobs (IT, cyber, aviation maintenance, etc.).
// Requires env.USAJOBS_API_KEY + env.USAJOBS_EMAIL (free, register at developer.usajobs.gov).
// Auto-detects same as Adzuna: silently skipped if not configured.
async function fetchUSAJobs(q, location, keys) {
  const apiKey = keys.usajobs_api_key;
  const email  = keys.usajobs_email;
  if (!apiKey || !email) return []; // silently skip if not configured

  const params = new URLSearchParams({ ResultsPerPage: '30' });
  if (q)        params.set('Keyword', q);
  if (location) params.set('LocationName', location);

  const r = await fetch(`https://data.usajobs.gov/api/search?${params}`, {
    headers: {
      'Host': 'data.usajobs.gov',
      'User-Agent': email,
      'Authorization-Key': apiKey,
    },
  });
  if (!r.ok) {
    let detail = '';
    try { detail = await r.text(); } catch {}
    throw new Error(`USAJobs HTTP ${r.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
  }
  const d = await r.json();
  const items = d?.SearchResult?.SearchResultItems || [];

  return items.map(item => {
    const j = item.MatchedObjectDescriptor || {};
    const pay = (j.PositionRemuneration || [])[0] || {};
    const loc = (j.PositionLocation || [])[0] || {};
    return {
      id: 'usaj_' + (j.PositionID || item.MatchedObjectId),
      title: j.PositionTitle || '',
      company: j.OrganizationName || 'U.S. Federal Government',
      location: loc.LocationName || location || '',
      remote: false,
      type: (j.PositionSchedule || [])[0]?.Name?.toLowerCase().includes('part') ? 'parttime' : 'fulltime',
      salary_min: pay.MinimumRange ? Number(pay.MinimumRange) : null,
      salary_max: pay.MaximumRange ? Number(pay.MaximumRange) : null,
      salary_period: pay.RateIntervalCode === 'PH' ? 'HOUR' : (pay.MinimumRange ? 'YEAR' : null),
      description: j.UserArea?.Details?.JobSummary || j.QualificationSummary || '',
      apply_url: j.ApplyURI?.[0] || j.PositionURI || '',
      posted_at: j.PublicationStartDate || null,
      source: 'USAJobs',
      tags: ['Federal', j.JobCategory?.[0]?.Name].filter(Boolean),
    };
  });
}

// Jooble - real US-aggregated job search engine (second US local source).
// Requires env.JOOBLE_API_KEY (free, register at jooble.org/api/about).
// Auto-detects same as Adzuna/USAJobs: silently skipped if not configured.
async function fetchJooble(q, location, keys, radius = '') {
  const apiKey = keys.jooble_api_key;
  if (!apiKey) return []; // silently skip if not configured

  const body = {
    keywords: q || '',
    location: location || 'United States',
    page: '1',
  };
  if (radius) body.radius = radius;

  const r = await fetch(`https://jooble.org/api/${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = '';
    try { detail = await r.text(); } catch {}
    throw new Error(`Jooble HTTP ${r.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
  }
  const d = await r.json();
  const items = d.jobs || [];

  return items.map(j => ({
    id: 'joo_' + j.id,
    title: j.title || '',
    company: j.company || 'Unknown',
    location: j.location || location || '',
    remote: false,
    type: String(j.type || '').toLowerCase().includes('part') ? 'parttime' : 'fulltime',
    salary_min: null, // Jooble returns salary as a free-text string, not min/max
    salary_max: null,
    salary_period: null,
    description: j.snippet || '',
    apply_url: j.link || '',
    posted_at: j.updated || null,
    source: 'Jooble',
    tags: j.salary ? [j.salary] : [], // surface raw salary string as a tag instead
  }));
}

async function fetchArbeitnow(q, location) {
  const params = new URLSearchParams({ page: 1 });
  if (q)        params.set('search', q);
  if (location) params.set('location', location);
  const r = await fetch(`https://www.arbeitnow.com/api/job-board-api?${params}`);
  if (!r.ok) return [];
  const d = await r.json();
  return (d.data || []).map(j => ({
    id: 'arb_' + j.slug,
    title: j.title,
    company: j.company_name,
    location: j.location || 'Remote',
    remote: j.remote || false,
    type: j.job_types?.[0] || '',
    salary_min: null,
    salary_max: null,
    salary_period: null,
    description: j.description || '',
    apply_url: j.url,
    posted_at: j.created_at ? new Date(j.created_at * 1000).toISOString() : null,
    source: 'Arbeitnow',
    tags: j.tags || [],
  }));
}

async function fetchJobicy(q) {
  const params = new URLSearchParams({ count: 50, geo: 'usa' });
  if (q) params.set('keyword', q);
  const r = await fetch(`https://jobicy.com/api/v2/remote-jobs?${params}`);
  if (!r.ok) return [];
  const d = await r.json();
  return (d.jobs || []).map(j => ({
    id: 'jcy_' + j.id,
    title: j.jobTitle,
    company: j.companyName,
    location: 'Remote',
    remote: true,
    type: j.jobType || '',
    salary_min: j.annualSalaryMin || null,
    salary_max: j.annualSalaryMax || null,
    salary_period: j.annualSalaryMin ? 'YEAR' : null,
    description: j.jobExcerpt || '',
    apply_url: j.url,
    posted_at: j.pubDate || null,
    source: 'Jobicy',
    tags: j.jobIndustry ? [j.jobIndustry] : [],
  }));
}

async function fetchGraphQLJobs(q) {
  const gql = `{
    jobs(input: { keywords: "${(q || 'developer').replace(/"/g, '')}", first: 30 }) {
      title
      company { name }
      applyUrl
      description
      cities { name country { isoCode } }
      salaryRange { min max currency period }
      postedAt
      commitment { title }
      tags { name }
    }
  }`;
  const r = await fetch('https://api.graphql.jobs/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gql }),
  });
  if (!r.ok) return [];
  const d = await r.json();
  return (d?.data?.jobs || []).map((j, i) => ({
    id: 'gql_' + i,
    title: j.title,
    company: j.company?.name || '',
    location: j.cities?.[0]?.name || 'Remote',
    remote: !j.cities?.length,
    type: j.commitment?.title || '',
    salary_min: j.salaryRange?.min || null,
    salary_max: j.salaryRange?.max || null,
    salary_period: j.salaryRange?.period || null,
    description: j.description || '',
    apply_url: j.applyUrl,
    posted_at: j.postedAt || null,
    source: 'GraphQL Jobs',
    tags: (j.tags || []).map(t => t.name),
  }));
}

// Himalayas - free, no key, remote jobs with US country filter support.
// Credit required: link back to himalayas.app per their usage terms.
async function fetchHimalayas(q) {
  const params = new URLSearchParams({ country: 'United States', limit: '20' });
  if (q) params.set('q', q);
  const r = await fetch(`https://himalayas.app/jobs/api/search?${params}`);
  if (!r.ok) return [];
  const d = await r.json();
  return (d.jobs || []).map(j => ({
    id: 'him_' + (j.id || j.guid || Math.random().toString(36).slice(2)),
    title: j.title || '',
    company: j.companyName || j.company?.name || 'Unknown',
    location: (j.locationRestrictions && j.locationRestrictions.length) ? j.locationRestrictions.join(', ') : 'Remote (Worldwide)',
    remote: true,
    type: j.employmentType || '',
    salary_min: j.minSalary || null,
    salary_max: j.maxSalary || null,
    salary_period: (j.minSalary || j.maxSalary) ? 'YEAR' : null,
    description: j.excerpt || j.description || '',
    apply_url: j.applicationLink || j.url || '',
    posted_at: j.pubDate || j.publishedAt || null,
    source: 'Himalayas',
    tags: j.categories || [],
  }));
}

// RemoteOK - free, no key, large remote-only board.
// Terms require: credit RemoteOK as source + direct link to listing (no redirects).
async function fetchRemoteOK(q) {
  const r = await fetch('https://remoteok.com/api', {
    headers: { 'User-Agent': 'Kindling-Worker (https://github.com/Dinadeyohvsgi/kindling)' },
  });
  if (!r.ok) return [];
  const d = await r.json();
  // First element is a legend/metadata object, not a job - skip it
  const list = Array.isArray(d) ? d.slice(1) : [];
  const ql = (q || '').toLowerCase();
  return list
    .filter(j => !ql || (j.position || '').toLowerCase().includes(ql) ||
                 (j.description || '').toLowerCase().includes(ql) ||
                 (j.tags || []).some(t => String(t || '').toLowerCase().includes(ql)))
    .slice(0, 40)
    .map(j => ({
      id: 'rok_' + j.id,
      title: j.position || '',
      company: j.company || 'Unknown',
      location: j.location || 'Remote',
      remote: true,
      type: j.contract ? 'contract' : 'fulltime',
      salary_min: j.salary_min || null,
      salary_max: j.salary_max || null,
      salary_period: (j.salary_min || j.salary_max) ? 'YEAR' : null,
      description: j.description || '',
      apply_url: j.url || ('https://remoteok.com' + (j.slug ? '/remote-jobs/' + j.slug : '')),
      posted_at: j.date || null,
      source: 'RemoteOK',
      tags: j.tags || [],
    }));
}
