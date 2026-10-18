// MKOS schema validator: the subset of JSON Schema (2020-12) the MKOS schemas use (adapted from the CKOS validator).
// Shared by the build (tools/mkos/build.mjs) and the server (imports, owner edits, extraction results).
// Supports: type (incl. arrays and "integer"), const, enum, required, properties, additionalProperties (schema),
// items, minItems, minLength, maxLength, minimum, maximum, pattern, format "date", allOf with $ref by file name.

const isDate = (s) => /^\d{4}-\d\d-\d\d$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
function typeOk(v, t) {
  switch (t) {
    case "null": return v === null;
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && isFinite(v);
    case "integer": return Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v);
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
  }
  return true;
}

// schemas: { "registry_entry.schema.json": {...}, ... }. Returns a list of { path, message }.
export function validate(value, schema, schemas = {}, path = "", out = []) {
  if (!schema || typeof schema !== "object") return out;
  if (schema.$ref) {
    const ref = schemas[schema.$ref.replace(/^.*\//, "")];
    if (!ref) out.push({ path, message: `unknown schema ${schema.$ref}` }); else validate(value, ref, schemas, path, out);
  }
  for (const s of schema.allOf || []) validate(value, s, schemas, path, out);
  if (value === undefined) return out;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(value, t))) { out.push({ path, message: `should be ${types.join(" or ")}` }); return out; }
  }
  if ("const" in schema && value !== schema.const) out.push({ path, message: `should be ${JSON.stringify(schema.const)}` });
  if (schema.enum && !schema.enum.includes(value)) out.push({ path, message: `should be one of ${schema.enum.join(", ")}` });
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) out.push({ path, message: `shorter than ${schema.minLength}` });
    if (schema.maxLength != null && value.length > schema.maxLength) out.push({ path, message: `longer than ${schema.maxLength}` });
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push({ path, message: `does not match ${schema.pattern}` });
    if (schema.format === "date" && !isDate(value)) out.push({ path, message: "is not a date (YYYY-MM-DD)" });
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) out.push({ path, message: `below ${schema.minimum}` });
    if (schema.maximum != null && value > schema.maximum) out.push({ path, message: `above ${schema.maximum}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) out.push({ path, message: `needs at least ${schema.minItems} item(s)` });
    if (schema.items) value.forEach((v, i) => validate(v, schema.items, schemas, `${path}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const k of schema.required || []) if (!(k in value)) out.push({ path: path ? `${path}.${k}` : k, message: "is required" });
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (sub) validate(v, sub, schemas, path ? `${path}.${k}` : k, out);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validate(v, schema.additionalProperties, schemas, path ? `${path}.${k}` : k, out);
      else if (schema.additionalProperties === false) out.push({ path: path ? `${path}.${k}` : k, message: "is not allowed" });
    }
  }
  return out;
}

// Reference fields of a type schema: { field: { type: TargetType, many: bool } }.
export function refFields(schema) {
  const out = {};
  for (const [k, p] of Object.entries(schema?.properties || {})) if (p && p["x-ref"]) out[k] = { type: p["x-ref"], many: p.type === "array" };
  return out;
}

// Empty for a required field of non-stub content: "", [], {} or null.
export const isEmpty = (v) => v == null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
