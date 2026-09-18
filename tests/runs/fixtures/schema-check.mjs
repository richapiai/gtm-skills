/**
 * A deliberately small JSON Schema subset validator, so the journal tests can assert
 * conformance against the ACTUAL frozen contract files rather than against a
 * re-typed copy of them. Zero deps (repo rule); supports only what the three
 * shared contracts use: type, required, properties, additionalProperties, enum,
 * const, minimum, pattern, items, $ref into $defs.
 */

import fs from 'node:fs';

export function loadSchema(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(value, expected) {
  const actual = typeOf(value);
  const list = Array.isArray(expected) ? expected : [expected];
  return list.some((t) => (t === 'number' ? actual === 'number' || actual === 'integer' : actual === t));
}

function resolve(schema, root) {
  if (schema && schema.$ref) {
    const key = schema.$ref.replace('#/$defs/', '');
    return root.$defs[key];
  }
  return schema;
}

export function validate(value, schema, root = schema, path = '$', errors = []) {
  const node = resolve(schema, root);
  if (!node) return errors;

  if (node.const !== undefined && value !== node.const) {
    errors.push(`${path}: expected const ${JSON.stringify(node.const)}, got ${JSON.stringify(value)}`);
  }
  if (node.enum && !node.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum [${node.enum.join(', ')}]`);
  }
  if (node.type && !typeMatches(value, node.type)) {
    errors.push(`${path}: expected type ${JSON.stringify(node.type)}, got ${typeOf(value)}`);
    return errors;
  }
  if (typeof value === 'string' && node.pattern && !new RegExp(node.pattern).test(value)) {
    errors.push(`${path}: does not match ${node.pattern}`);
  }
  if (typeof value === 'number' && node.minimum !== undefined && value < node.minimum) {
    errors.push(`${path}: ${value} < minimum ${node.minimum}`);
  }
  if (typeof value === 'string' && node.format === 'date-time' && Number.isNaN(Date.parse(value))) {
    errors.push(`${path}: not a date-time`);
  }
  if (typeOf(value) === 'object') {
    for (const key of node.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required "${key}"`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = node.properties?.[key];
      if (childSchema) {
        validate(child, childSchema, root, `${path}.${key}`, errors);
      } else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
        validate(child, node.additionalProperties, root, `${path}.${key}`, errors);
      } else if (node.additionalProperties === false) {
        errors.push(`${path}: additional property "${key}" is not allowed`);
      } else if (node.properties && node.additionalProperties === undefined) {
        // The frozen contracts do not set additionalProperties. This validator holds to
        // the stricter reading: a key the contract never declared is a contract break.
        errors.push(`${path}: undeclared property "${key}"`);
      }
    }
  }
  if (typeOf(value) === 'array' && node.items) {
    value.forEach((item, i) => validate(item, node.items, root, `${path}[${i}]`, errors));
  }
  return errors;
}

export function assertValid(value, schema, label = 'value') {
  const errors = validate(value, schema);
  if (errors.length) {
    throw new Error(`${label} does not conform to ${schema.$id ?? 'schema'}:\n  ${errors.join('\n  ')}`);
  }
}
