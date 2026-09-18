// A deliberately small JSON Schema validator, supporting exactly the keywords used by
// _lib/contracts/api-catalog.schema.json: type, const, enum, required, properties,
// additionalProperties, items, pattern, $ref into #/$defs.
//
// The catalog generator must prove its output satisfies a FROZEN contract. Asserting a handful of
// fields by hand would pass while the contract quietly broke somewhere else, and adding
// a real validator as a runtime dependency is not justified for one build-time check.

export function validate(schema, data, root = schema, pathStr = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.$ref) {
    const target = resolveRef(root, schema.$ref);
    if (!target) return [`${pathStr}: cannot resolve $ref ${schema.$ref}`];
    return validate(target, data, root, pathStr);
  }

  if (schema.const !== undefined && data !== schema.const) {
    errors.push(`${pathStr}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
  }
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${pathStr}: ${JSON.stringify(data)} not in enum [${schema.enum.join(', ')}]`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, data))) {
      errors.push(`${pathStr}: expected type ${types.join('|')}, got ${describe(data)}`);
    }
  }
  if (schema.pattern && typeof data === 'string' && !new RegExp(schema.pattern).test(data)) {
    errors.push(`${pathStr}: ${JSON.stringify(data)} fails pattern ${schema.pattern}`);
  }
  if (Array.isArray(schema.required) && data && typeof data === 'object' && !Array.isArray(data)) {
    for (const k of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(data, k)) errors.push(`${pathStr}: missing required "${k}"`);
    }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [k, v] of Object.entries(data)) {
      const sub = schema.properties?.[k];
      if (sub) errors.push(...validate(sub, v, root, `${pathStr}.${k}`));
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validate(schema.additionalProperties, v, root, `${pathStr}.${k}`));
      } else if (schema.additionalProperties === false && schema.properties) {
        errors.push(`${pathStr}: unexpected property "${k}"`);
      }
    }
  }
  if (Array.isArray(data) && schema.items) {
    data.forEach((v, i) => errors.push(...validate(schema.items, v, root, `${pathStr}[${i}]`)));
  }
  return errors;
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) return null;
  return ref
    .slice(2)
    .split('/')
    .reduce((acc, seg) => (acc ? acc[seg.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), root);
}

function matchesType(t, v) {
  switch (t) {
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array':
      return Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number';
    case 'integer':
      return Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    default:
      return true;
  }
}

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
