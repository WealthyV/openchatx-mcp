import type { SubagentModelProfile, SubagentProviderConfig } from "./config.js"

const OPENCODE_GO_MODEL_PREFIX_RE = /^opencode-go\//iu

export function isOpenCodeGoEndpoint(baseUrl: string): boolean {
  const url = new URL(baseUrl)
  return url.hostname === "opencode.ai" && url.pathname.startsWith("/inference/go/")
}

export function isOpenCodeGoBeamFree(
  provider: Extract<SubagentProviderConfig, { type: "openai-compatible" }>,
  profile: SubagentModelProfile
): boolean {
  const model = profile.model.replace(OPENCODE_GO_MODEL_PREFIX_RE, "").toLowerCase()
  return model === "beam-free" && isOpenCodeGoEndpoint(provider.base_url)
}

/**
 * Beam Free rejects JSON Schema composition keywords at the function-parameters
 * root. Expand object compositions into alternatives, then project those
 * alternatives into one object schema with property-level unions.
 */
export function beamFreeFunctionParameters(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const alternatives = expandObjectSchema(schema)
  const properties = mergeProperties(alternatives)
  const required = mergeRequired(alternatives)
  const description = describeVariants(schema.description, alternatives)
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    ...(alternatives.length > 0 &&
    alternatives.every((branch) => branch.additionalProperties === false)
      ? { additionalProperties: false }
      : {}),
    ...(description ? { description } : {}),
  }
}

function expandObjectSchema(schema: Record<string, unknown>): Record<string, unknown>[] {
  const { oneOf, anyOf, allOf, enum: _enum, const: _const, not: _not, ...base } = schema
  const union = schemaBranches(oneOf ?? anyOf)
  let alternatives = union.length ? union.flatMap(expandObjectSchema) : [base]
  if (union.length) alternatives = alternatives.map((branch) => intersectSchemas(base, branch))

  for (const intersection of schemaBranches(allOf)) {
    const intersectionAlternatives = expandObjectSchema(intersection)
    alternatives = alternatives.flatMap((left) =>
      intersectionAlternatives.map((right) => intersectSchemas(left, right))
    )
  }
  return alternatives
}

function intersectSchemas(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): Record<string, unknown> {
  const leftProperties = schemaProperties(left)
  const rightProperties = schemaProperties(right)
  const properties: Record<string, unknown> = { ...leftProperties }
  for (const [name, schema] of Object.entries(rightProperties)) {
    const existing = properties[name]
    properties[name] = existing ? { allOf: [existing, schema] } : schema
  }
  const description = [left.description, right.description]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
  return {
    properties,
    required: [...new Set([...stringArray(left.required), ...stringArray(right.required)])],
    ...(left.additionalProperties === false || right.additionalProperties === false
      ? { additionalProperties: false }
      : {}),
    ...(description ? { description } : {}),
    ...(typeof left.title === "string" ? { title: left.title } : {}),
  }
}

function schemaBranches(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  return isRecord(schema.properties) ? schema.properties : {}
}

function mergeProperties(alternatives: Record<string, unknown>[]): Record<string, unknown> {
  const branchProperties = alternatives.map(schemaProperties)
  const names = new Set(branchProperties.flatMap((entry) => Object.keys(entry)))
  const properties: Record<string, unknown> = {}
  for (const name of names) {
    const schemas = uniqueSchemas(branchProperties.map((entry) => entry[name]))
    properties[name] = schemas.length > 1 ? { anyOf: schemas } : schemas[0]
  }
  return properties
}

function mergeRequired(alternatives: Record<string, unknown>[]): string[] {
  const requiredByBranch = alternatives.map((branch) => new Set(stringArray(branch.required)))
  const first = requiredByBranch[0]
  return first
    ? [...first].filter((name) => requiredByBranch.every((fields) => fields.has(name)))
    : []
}

function describeVariants(
  rootDescription: unknown,
  alternatives: Record<string, unknown>[]
): string | undefined {
  const variants = alternatives
    .map((branch, index) => {
      let label = `variant ${index + 1}`
      if (typeof branch.title === "string") label = branch.title
      else if (typeof branch.description === "string") label = branch.description
      const required = stringArray(branch.required)
      return required.length ? `${label} (requires: ${required.join(", ")})` : label
    })
    .filter((label, index, all) => all.indexOf(label) === index)
  const descriptions = [
    typeof rootDescription === "string" ? rootDescription : undefined,
    variants.length > 1 ? `Choose one input variant: ${variants.join("; ")}.` : undefined,
  ].filter((part): part is string => Boolean(part))
  return descriptions.length ? descriptions.join(" ") : undefined
}

function uniqueSchemas(values: unknown[]): unknown[] {
  const seen = new Set<string>()
  const unique: unknown[] = []
  for (const value of values) {
    if (value === undefined) continue
    const key = JSON.stringify(value)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(value)
  }
  return unique
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
