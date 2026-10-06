// Deterministic validator for the JSON Schema vocabulary used by our checked-in
// schemas. Unsupported validation keywords fail closed instead of being ignored.
export function validateSchema(schema, value, path = '$') {
  const supported = new Set(['$schema', '$id', 'title', 'description', 'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'minLength', 'maxLength', 'pattern', 'minimum', 'minItems']);
  for (const key of Object.keys(schema)) if (!supported.has(key)) return `${path}: unsupported schema keyword ${key}`;
  if ('const' in schema && value !== schema.const) return `${path}: const`;
  if (schema.enum && !schema.enum.includes(value)) return `${path}: enum`;
  const types = { object: v => !!v && typeof v === 'object' && !Array.isArray(v), array: Array.isArray, string: v => typeof v === 'string', integer: Number.isInteger, boolean: v => typeof v === 'boolean', number: v => typeof v === 'number' && Number.isFinite(v), null: v => v === null };
  if (schema.type && (!types[schema.type] || !types[schema.type](value))) return `${path}: type`;
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) return `${path}: minLength`;
    if (schema.maxLength != null && value.length > schema.maxLength) return `${path}: maxLength`;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path}: pattern`;
  }
  if (schema.minimum != null && value < schema.minimum) return `${path}: minimum`;
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) return `${path}: minItems`;
    for (let i = 0; schema.items && i < value.length; i++) { const error = validateSchema(schema.items, value[i], `${path}[${i}]`); if (error) return error; }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return `${path}.${key}: required`;
    for (const [key, entry] of Object.entries(value)) {
      if (schema.additionalProperties === false && !Object.hasOwn(schema.properties ?? {}, key)) return `${path}.${key}: additionalProperties`;
      if (schema.properties?.[key]) { const error = validateSchema(schema.properties[key], entry, `${path}.${key}`); if (error) return error; }
    }
  }
  return null;
}
