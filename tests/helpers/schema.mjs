// Minimal JSON Schema (draft 2020-12 subset) validator — zero dependencies.
//
// WHY NOT ajv: CI has no `npm install` step and the repo is zero-runtime-dep by
// policy, so a validator dependency would make `node --test` fail on a fresh
// clone — the exact wedge the fixtures exist to prevent.
//
// The safety property that makes a hand-rolled validator acceptable here is
// `assertValidJsonSchema`: it walks a schema and THROWS on any keyword this
// validator does not enforce. So a frozen contract cannot quietly grow a
// keyword that validation ignores; it fails the contract suite instead. If a
// change needs an unsupported keyword, implement it here in the same PR.

/** Keywords that carry no validation semantics for us. */
const ANNOTATION_KEYWORDS = new Set([
  '$schema', '$id', '$anchor', '$comment', 'title', 'description', 'default',
  'examples', 'deprecated', 'readOnly', 'writeOnly', '$defs', 'definitions'
]);

/** Keywords this validator actually enforces. */
const SUPPORTED_KEYWORDS = new Set([
  '$ref', 'type', 'enum', 'const', 'required', 'properties',
  'patternProperties', 'additionalProperties', 'items', 'prefixItems',
  'minItems', 'maxItems', 'uniqueItems', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength',
  'maxLength', 'pattern', 'format', 'allOf', 'anyOf', 'oneOf', 'not',
  'minProperties', 'maxProperties'
]);

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/**
 * Formats enforced assertively. JSON Schema treats `format` as an annotation
 * by default; the contracts use it to mean something, so we mean it too.
 */
const FORMATS = {
  'date-time': (v) => typeof v !== 'string' || (/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v))),
  date: (v) => typeof v !== 'string' || /^\d{4}-\d{2}-\d{2}$/.test(v),
  uri: (v) => typeof v !== 'string' || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v),
  email: (v) => typeof v !== 'string' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
};

export class SchemaSupportError extends Error {
  constructor (message) { super(message); this.name = 'SchemaSupportError'; }
}

function typeOf (value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType (value, t) {
  if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeOf(value) === t;
}

function resolveRef (ref, root, where) {
  if (!ref.startsWith('#')) throw new SchemaSupportError(`only local $ref is supported, got "${ref}" at ${where}`);
  const parts = ref.slice(1).split('/').filter(Boolean).map(p => decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~')));
  let node = root;
  for (const p of parts) {
    if (node == null || typeof node !== 'object' || !(p in node)) {
      throw new SchemaSupportError(`$ref "${ref}" does not resolve (missing "${p}") at ${where}`);
    }
    node = node[p];
  }
  return node;
}

/**
 * Assert a schema uses only constructs this validator enforces, that every
 * local $ref resolves, and that every `pattern` compiles.
 *
 * @param {object} schema
 * @param {string} [label] used in error messages
 * @param {object} [root]  defaults to `schema`
 */
export function assertValidJsonSchema (schema, label = '<schema>', root = schema) {
  const seen = new Set();

  const walk = (node, where) => {
    if (node === true || node === false) return;
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      throw new SchemaSupportError(`${label}: schema at ${where} must be an object or boolean, got ${typeOf(node)}`);
    }
    if (seen.has(node)) return;
    seen.add(node);

    for (const key of Object.keys(node)) {
      if (ANNOTATION_KEYWORDS.has(key)) continue;
      if (key.startsWith('x-')) continue;
      if (!SUPPORTED_KEYWORDS.has(key)) {
        throw new SchemaSupportError(
          `${label}: keyword "${key}" at ${where} is not enforced by tests/helpers/schema.mjs. ` +
          'Implement it there in the same change, or the contract will be silently unvalidated.'
        );
      }
    }

    if ('$ref' in node) {
      if (typeof node.$ref !== 'string') throw new SchemaSupportError(`${label}: $ref at ${where} must be a string`);
      resolveRef(node.$ref, root, `${label}${where}`);
    }
    if ('type' in node) {
      const ts = Array.isArray(node.type) ? node.type : [node.type];
      for (const t of ts) if (!TYPES.has(t)) throw new SchemaSupportError(`${label}: unknown type "${t}" at ${where}`);
    }
    if ('required' in node) {
      if (!Array.isArray(node.required) || node.required.some(r => typeof r !== 'string')) {
        throw new SchemaSupportError(`${label}: "required" at ${where} must be an array of strings`);
      }
    }
    if ('enum' in node) {
      if (!Array.isArray(node.enum) || node.enum.length === 0) {
        throw new SchemaSupportError(`${label}: "enum" at ${where} must be a non-empty array`);
      }
    }
    if ('pattern' in node) {
      try { new RegExp(node.pattern, 'u'); } catch (e) { throw new SchemaSupportError(`${label}: "pattern" at ${where} is not a valid regex: ${e.message}`); }
    }
    if ('format' in node && !(node.format in FORMATS)) {
      throw new SchemaSupportError(`${label}: format "${node.format}" at ${where} is not enforced by tests/helpers/schema.mjs`);
    }
    for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) {
      if (k in node && typeof node[k] !== 'number') throw new SchemaSupportError(`${label}: "${k}" at ${where} must be a number`);
    }

    for (const k of ['properties', 'patternProperties', '$defs', 'definitions']) {
      if (k in node) {
        if (node[k] === null || typeof node[k] !== 'object' || Array.isArray(node[k])) {
          throw new SchemaSupportError(`${label}: "${k}" at ${where} must be an object`);
        }
        for (const [name, sub] of Object.entries(node[k])) walk(sub, `${where}/${k}/${name}`);
      }
    }
    if ('patternProperties' in node) {
      for (const p of Object.keys(node.patternProperties)) {
        try { new RegExp(p, 'u'); } catch (e) { throw new SchemaSupportError(`${label}: patternProperties key "${p}" at ${where} is not a valid regex`); }
      }
    }
    if ('additionalProperties' in node && typeof node.additionalProperties === 'object') walk(node.additionalProperties, `${where}/additionalProperties`);
    if ('items' in node) walk(node.items, `${where}/items`);
    if ('prefixItems' in node) {
      if (!Array.isArray(node.prefixItems)) throw new SchemaSupportError(`${label}: "prefixItems" at ${where} must be an array`);
      node.prefixItems.forEach((s, i) => walk(s, `${where}/prefixItems/${i}`));
    }
    if ('not' in node) walk(node.not, `${where}/not`);
    for (const k of ['allOf', 'anyOf', 'oneOf']) {
      if (k in node) {
        if (!Array.isArray(node[k]) || node[k].length === 0) throw new SchemaSupportError(`${label}: "${k}" at ${where} must be a non-empty array`);
        node[k].forEach((s, i) => walk(s, `${where}/${k}/${i}`));
      }
    }
  };

  walk(schema, '#');
  return true;
}

/**
 * Validate `data` against `schema`.
 * @returns {{valid: boolean, errors: Array<{path: string, message: string}>}}
 */
export function validate (schema, data, { root = schema } = {}) {
  const errors = [];

  const fail = (path, message) => errors.push({ path: path || '#', message });

  const check = (node, value, path) => {
    if (node === true || node === undefined) return;
    if (node === false) { fail(path, 'schema is `false`: no value is valid here'); return; }

    if ('$ref' in node) {
      check(resolveRef(node.$ref, root, path), value, path);
      // 2020-12 allows siblings alongside $ref; keep checking them.
    }

    if ('type' in node) {
      const ts = Array.isArray(node.type) ? node.type : [node.type];
      if (!ts.some(t => matchesType(value, t))) {
        fail(path, `expected type ${ts.join(' | ')}, got ${typeOf(value)}`);
        return; // further keywords would produce noise
      }
    }
    if ('const' in node && !deepEqual(value, node.const)) {
      fail(path, `expected const ${JSON.stringify(node.const)}, got ${JSON.stringify(value)}`);
    }
    if ('enum' in node && !node.enum.some(e => deepEqual(value, e))) {
      fail(path, `expected one of ${JSON.stringify(node.enum)}, got ${JSON.stringify(value)}`);
    }

    if (typeof value === 'string') {
      if ('minLength' in node && value.length < node.minLength) fail(path, `shorter than minLength ${node.minLength}`);
      if ('maxLength' in node && value.length > node.maxLength) fail(path, `longer than maxLength ${node.maxLength}`);
      if ('pattern' in node && !new RegExp(node.pattern, 'u').test(value)) fail(path, `does not match pattern ${node.pattern}`);
      if ('format' in node && FORMATS[node.format] && !FORMATS[node.format](value)) fail(path, `is not a valid ${node.format}`);
    }

    if (typeof value === 'number') {
      if ('minimum' in node && value < node.minimum) fail(path, `less than minimum ${node.minimum}`);
      if ('maximum' in node && value > node.maximum) fail(path, `greater than maximum ${node.maximum}`);
      if ('exclusiveMinimum' in node && value <= node.exclusiveMinimum) fail(path, `not greater than exclusiveMinimum ${node.exclusiveMinimum}`);
      if ('exclusiveMaximum' in node && value >= node.exclusiveMaximum) fail(path, `not less than exclusiveMaximum ${node.exclusiveMaximum}`);
      if ('multipleOf' in node && !Number.isInteger(value / node.multipleOf)) fail(path, `not a multiple of ${node.multipleOf}`);
    }

    if (Array.isArray(value)) {
      if ('minItems' in node && value.length < node.minItems) fail(path, `fewer than minItems ${node.minItems}`);
      if ('maxItems' in node && value.length > node.maxItems) fail(path, `more than maxItems ${node.maxItems}`);
      if (node.uniqueItems) {
        const seen = new Set(value.map(v => JSON.stringify(v)));
        if (seen.size !== value.length) fail(path, 'items are not unique');
      }
      const prefix = node.prefixItems ?? [];
      value.forEach((v, i) => {
        if (i < prefix.length) check(prefix[i], v, `${path}/${i}`);
        else if ('items' in node) check(node.items, v, `${path}/${i}`);
      });
    }

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if ('minProperties' in node && keys.length < node.minProperties) fail(path, `fewer than minProperties ${node.minProperties}`);
      if ('maxProperties' in node && keys.length > node.maxProperties) fail(path, `more than maxProperties ${node.maxProperties}`);
      for (const r of node.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, r)) fail(path, `missing required property "${r}"`);
      }
      const props = node.properties ?? {};
      const patterns = Object.entries(node.patternProperties ?? {}).map(([p, s]) => [new RegExp(p, 'u'), s]);
      for (const k of keys) {
        let matched = false;
        if (k in props) { check(props[k], value[k], `${path}/${k}`); matched = true; }
        for (const [re, sub] of patterns) if (re.test(k)) { check(sub, value[k], `${path}/${k}`); matched = true; }
        if (!matched && 'additionalProperties' in node) {
          if (node.additionalProperties === false) fail(`${path}/${k}`, 'additional property is not allowed');
          else check(node.additionalProperties, value[k], `${path}/${k}`);
        }
      }
    }

    if ('not' in node) {
      const r = validate(node.not, value, { root });
      if (r.valid) fail(path, 'value matches a schema it must not match');
    }
    for (const sub of node.allOf ?? []) check(sub, value, path);
    if ('anyOf' in node && !node.anyOf.some(s => validate(s, value, { root }).valid)) {
      fail(path, 'value does not match any schema in anyOf');
    }
    if ('oneOf' in node) {
      const n = node.oneOf.filter(s => validate(s, value, { root }).valid).length;
      if (n !== 1) fail(path, `value matches ${n} schemas in oneOf, expected exactly 1`);
    }
  };

  check(schema, data, '');
  return { valid: errors.length === 0, errors };
}

function deepEqual (a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (a !== null && typeof a === 'object') {
    const ka = Object.keys(a); const kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

/** Render errors as a readable multi-line block. */
export function formatErrors (errors) {
  return errors.map(e => `  ${e.path}: ${e.message}`).join('\n');
}

export default { validate, assertValidJsonSchema, formatErrors, SchemaSupportError };
