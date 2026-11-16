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
 * root. Project object unions into a plain object, retaining property variants
 * and documenting branch-specific required fields for the model.
 */
export function beamFreeFunctionParameters(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const { oneOf, anyOf, allOf, enum: _enum, const: _const, not: _not, ...root } = schema
  const unionBranches = schemaBranches(oneOf ?? anyOf)
  const intersectionBranches = schemaBranches(allOf)
  const branches = [...unionBranches, ...intersectionBranches]
  const properties = mergeProperties(root, unionBranches, intersectionBranches)
  const required = mergeRequired(root, unionBranches, intersectionBranches)
  const description = describeVariants(root.description, branches)
  return {
    ...root,
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    ...(disallowsAdditionalProperties(root, unionBranches, intersectionBranches)
      ? { additionalProperties: false }
      : {}),
    ...(description ? { description } : {}),
  }
}

function schemaBranches(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function mergeProperties(
  root: Record<string, unknown>,
  unionBranches: Record<string, unknown>[],
  intersectionBranches: Record<string, unknown>[]
): Record<string, unknown> {
  const properties: Record<string, unknown> = isRecord(root.properties)
    ? { ...root.properties }
    : {}
  const unionProperties = unionBranches.map(schemaProperties)
  const intersectionProperties = intersectionBranches.map(schemaProperties)
  const names = new Set([
    ...Object.keys(properties),
    ...unionProperties.flatMap((entry) => Object.keys(entry)),
    ...intersectionProperties.flatMap((entry) => Object.keys(entry)),
  ])
  for (const name of names) {
    const unionSchema = combineSchemaVariants(
      unionProperties.map((entry) => entry[name]),
      "anyOf"
    )
    const intersectionSchema = combineSchemaVariants(
      [properties[name], ...intersectionProperties.map((entry) => entry[name])],
      "allOf"
    )
    properties[name] = combinePropertyConstraints(unionSchema, intersectionSchema)
  }
  return properties
}

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  return isRecord(schema.properties) ? schema.properties : {}
}

function combineSchemaVariants(values: unknown[], keyword: "anyOf" | "allOf"): unknown {
  const schemas = uniqueSchemas(values)
  if (schemas.length > 1) return { [keyword]: schemas }
  return schemas[0]
}

function combinePropertyConstraints(unionSchema: unknown, intersectionSchema: unknown): unknown {
  if (unionSchema && intersectionSchema) return { allOf: [intersectionSchema, unionSchema] }
  return intersectionSchema ?? unionSchema
}

function mergeRequired(
  root: Record<string, unknown>,
  unionBranches: Record<string, unknown>[],
  intersectionBranches: Record<string, unknown>[]
): string[] {
  const requiredByUnion = unionBranches.map((branch) => new Set(stringArray(branch.required)))
  const commonRequired = requiredByUnion[0]
    ? [...requiredByUnion[0]].filter((name) => requiredByUnion.every((fields) => fields.has(name)))
    : []
  const requiredByIntersection = intersectionBranches.flatMap((branch) =>
    stringArray(branch.required)
  )
  return [...new Set([...stringArray(root.required), ...commonRequired, ...requiredByIntersection])]
}

function describeVariants(
  rootDescription: unknown,
  branches: Record<string, unknown>[]
): string | undefined {
  const variants = branches.map((branch, index) => {
    let label = `variant ${index + 1}`
    if (typeof branch.title === "string") label = branch.title
    else if (typeof branch.description === "string") label = branch.description
    const required = stringArray(branch.required)
    return required.length ? `${label} (requires: ${required.join(", ")})` : label
  })
  const descriptions = [
    typeof rootDescription === "string" ? rootDescription : undefined,
    variants.length ? `Choose one input variant: ${variants.join("; ")}.` : undefined,
  ].filter((part): part is string => Boolean(part))
  return descriptions.length ? descriptions.join(" ") : undefined
}

function disallowsAdditionalProperties(
  root: Record<string, unknown>,
  unionBranches: Record<string, unknown>[],
  intersectionBranches: Record<string, unknown>[]
): boolean {
  return (
    root.additionalProperties === false ||
    (unionBranches.length > 0 &&
      unionBranches.every((branch) => branch.additionalProperties === false)) ||
    intersectionBranches.some((branch) => branch.additionalProperties === false)
  )
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
